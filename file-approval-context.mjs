import { createHash } from "node:crypto";

const validId = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 160 && !/[\x00-\x1f]/u.test(value);
const unavailable = Object.freeze({ status: "unavailable" });

export function fileApprovalKey({ threadId, turnId, itemId } = {}) {
  return [threadId, turnId, itemId].every(validId) ? JSON.stringify([threadId, turnId, itemId]) : null;
}

// Keep only recent, bounded file-impact summaries. Diffs contribute to request
// identity but their bodies are never retained by this cache or sent as context.
export class FileApprovalContexts {
  constructor({ now = Date.now, maxEntries = 64, maxChanges = 32, ttlMs = 300_000 } = {}) {
    Object.assign(this, { now, ttlMs });
    this.maxEntries = Math.max(1, Math.min(64, maxEntries));
    this.maxChanges = Math.max(1, Math.min(32, maxChanges));
    this.entries = new Map();
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) if (entry.at <= cutoff) this.entries.delete(key);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }

  observe(message) {
    const { method, params = {} } = message || {};
    if (["thread/closed", "thread/deleted", "turn/completed"].includes(method)) {
      for (const [key, entry] of this.entries) {
        if (entry.threadId === params.threadId && (method !== "turn/completed" || entry.turnId === params.turn?.id)) this.entries.delete(key);
      }
      return null;
    }
    const patchUpdate = method === "item/fileChange/patchUpdated";
    if (!patchUpdate && (!["item/started", "item/completed"].includes(method) || params.item?.type !== "fileChange")) return null;
    const key = fileApprovalKey({ ...params, itemId: patchUpdate ? params.itemId : params.item.id });
    if (!key) return null;
    const source = patchUpdate ? params.changes : params.item.changes;
    let context = unavailable;
    if (Array.isArray(source)) {
      const changes = [];
      let destructive = false, incomplete = source.length === 0, truncated = source.length > this.maxChanges;
      const pathText = (value) => {
        if (typeof value !== "string" || !value.trim()) { incomplete = true; return ""; }
        if (value.length > 1024) { incomplete = true; truncated = true; return `${value.slice(0, 1024)}…`; }
        return value;
      };
      for (const change of source) {
        const type = change?.kind?.type;
        if (type === "delete") destructive = true;
        if (!["add", "delete", "update"].includes(type)) incomplete = true;
        // Check every change for risk, even after the display limit is reached.
        if (changes.length >= this.maxChanges) continue;
        const path = pathText(change?.path);
        const kind = { type: ["add", "delete", "update"].includes(type) ? type : "unknown" };
        if (type === "update") kind.move_path = change.kind.move_path == null ? null : pathText(change.kind.move_path);
        changes.push({ path, kind });
      }
      context = { status: "available", source: "app-server/fileChange", changes, totalFiles: source.length,
        destructive, incomplete, truncated,
        fingerprint: createHash("sha256").update(JSON.stringify(source)).digest("hex") };
    }
    this.entries.delete(key);
    this.entries.set(key, { threadId: params.threadId, turnId: params.turnId, context, at: this.now() });
    this.prune();
    return key;
  }

  get(params) {
    this.prune();
    return this.entries.get(fileApprovalKey(params))?.context || unavailable;
  }

  clear() { this.entries.clear(); }
}
