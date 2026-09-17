import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const terminal = new Set(["completed", "failed", "interrupted"]);
const validId = (id) => typeof id === "string" && id.length > 0 && id.length <= 160 && !/[\x00-\x1f]/u.test(id);

// This is an observation journal, not a subscription or a writer lease. Recovery
// may only query tasks already observed by this PWA, and must recheck root access.
export class TaskRecovery {
  constructor({ persistencePath = "", readSnapshot, onRecovered = () => {}, onUnconfirmed = () => {},
    now = Date.now, maxTracked = 256, intervalMs = 15_000, concurrency = 4 } = {}) {
    Object.assign(this, { persistencePath, readSnapshot, onRecovered, onUnconfirmed, now, intervalMs });
    this.maxTracked = Math.max(1, Math.min(256, maxTracked));
    this.concurrency = Math.max(1, Math.min(4, concurrency));
    this.entries = new Map();
    this.storageHealthy = true;
    this.storageBlocked = false;
    this.dropped = 0;
    this.closed = false;
    this.pending = null;
    this.load();
  }

  load() {
    if (!this.persistencePath) return;
    try {
      const stat = lstatSync(this.persistencePath);
      if (!stat.isFile() || stat.size > 512 * 1024) throw new Error("invalid recovery file");
      const data = JSON.parse(readFileSync(this.persistencePath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.tasks) || data.tasks.length > 256) throw new Error("invalid recovery data");
      const entries = new Map();
      for (const record of data.tasks) {
        if (!validId(record?.threadId) || !validId(record.turnId)
          || !["running", "unconfirmed", ...terminal].includes(record.status)
          || !Number.isFinite(record.observedAt)) throw new Error("invalid recovery entry");
        entries.set(record.threadId, { threadId: record.threadId, turnId: record.turnId,
          status: terminal.has(record.status) ? record.status : "unconfirmed",
          observedAt: record.observedAt, nextCheckAt: 0 });
      }
      this.entries = entries;
      this.trim();
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Keep a damaged original available for diagnosis; never replace it with
        // an apparently healthy empty journal on the next live notification.
        this.storageHealthy = false;
        this.storageBlocked = true;
      }
    }
  }

  persist() {
    if (!this.persistencePath || this.storageBlocked) return;
    const temporary = `${this.persistencePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true, mode: 0o700 });
      const tasks = [...this.entries.values()].map(({ threadId, turnId, status, observedAt }) =>
        ({ threadId, turnId, status, observedAt }));
      writeFileSync(temporary, JSON.stringify({ version: 1, tasks }) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.persistencePath);
      this.storageHealthy = true;
    } catch {
      this.storageHealthy = false;
    } finally {
      try { unlinkSync(temporary); } catch {}
    }
  }

  trim() {
    while (this.entries.size > this.maxTracked) {
      const entries = [...this.entries.values()];
      const oldest = entries.find((entry) => terminal.has(entry.status)) || entries[0];
      this.entries.delete(oldest.threadId);
      if (!terminal.has(oldest.status)) this.dropped += 1;
    }
  }

  observe(payload) {
    if (this.closed || payload?.kind !== "app-server/notification") return;
    const { method, params = {} } = payload.message || {};
    const { threadId, turn } = params;
    if (!validId(threadId)) return;
    const previous = this.entries.get(threadId);
    if (method === "thread/deleted") {
      if (this.entries.delete(threadId)) this.persist();
      return;
    }
    if (!validId(turn?.id)) return;
    if (method !== "turn/started" && method !== "turn/completed") return;
    if (method === "turn/completed" && (!previous || previous.turnId !== turn.id || !terminal.has(turn.status))) return;
    const status = method === "turn/started" ? "running" : turn.status;
    // A fresh object invalidates any read already in flight, even on repeats.
    this.entries.set(threadId, { threadId, turnId: turn.id, status, observedAt: this.now(), nextCheckAt: this.now() + this.intervalMs });
    this.trim();
    this.persist();
  }

  invalidate(threadId = null) {
    for (const [id, entry] of this.entries) {
      if (threadId !== null && id !== threadId) continue;
      if (terminal.has(entry.status)) continue;
      this.entries.set(id, { ...entry, status: "unconfirmed", nextCheckAt: 0 });
      this.onUnconfirmed(entry);
    }
  }

  reconcile({ force = false } = {}) {
    if (this.closed || !this.readSnapshot) return Promise.resolve();
    if (this.pending) return this.pending;
    const work = [...this.entries.values()].filter((entry) => !terminal.has(entry.status)
      && (force || entry.nextCheckAt <= this.now()));
    let index = 0;
    this.pending = Promise.all(Array.from({ length: Math.min(this.concurrency, work.length) }, async () => {
      while (index < work.length && !this.closed) await this.recover(work[index++]);
    })).finally(() => { this.pending = null; });
    return this.pending;
  }

  async recover(entry) {
    const current = () => !this.closed && this.entries.get(entry.threadId) === entry;
    if (!current()) return;
    let snapshot;
    try { snapshot = await this.readSnapshot(entry.threadId); }
    catch (error) {
      if (!current()) return;
      if (error.statusCode === 403) {
        this.entries.delete(entry.threadId);
        this.onUnconfirmed(entry);
        this.persist();
        return;
      }
    }
    if (!current()) return;
    const turn = snapshot?.turn;
    const type = snapshot?.threadStatus?.type;
    let status = "unconfirmed";
    if (validId(turn?.id)) {
      if (type === "active" && turn.status === "inProgress") status = "running";
      else if (["idle", "notLoaded"].includes(type) && terminal.has(turn.status)) status = turn.status;
    }
    // Only the known turn's completion is recoverable. A newer running turn can
    // be followed, but unrelated old terminal history cannot end this task.
    if (terminal.has(status) && turn.id !== entry.turnId) status = "unconfirmed";
    const next = { threadId: entry.threadId, turnId: status === "running" ? turn.id : entry.turnId,
      status, observedAt: this.now(), nextCheckAt: this.now() + this.intervalMs };
    this.entries.set(entry.threadId, next);
    if (status === "unconfirmed") this.onUnconfirmed(entry);
    if (status !== entry.status || next.turnId !== entry.turnId || !this.storageHealthy) this.persist();
    if (status !== "unconfirmed" && (status !== entry.status || next.turnId !== entry.turnId)) {
      this.onRecovered({ threadId: next.threadId, turnId: next.turnId, status, checkedAt: next.observedAt });
    }
  }

  snapshot() {
    const values = [...this.entries.values()];
    return { persistent: Boolean(this.persistencePath), storageHealthy: this.storageHealthy,
      tracked: values.length, running: values.filter((entry) => entry.status === "running").length,
      unconfirmed: values.filter((entry) => entry.status === "unconfirmed").length,
      completed: values.filter((entry) => terminal.has(entry.status)).length, dropped: this.dropped,
      maxTracked: this.maxTracked, intervalMs: this.intervalMs };
  }

  close() { this.closed = true; }
}
