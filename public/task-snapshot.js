import { threadStatusInfo } from "./status-display.js";

const SNAPSHOT_LIMIT = 200;
const validId = (id) => typeof id === "string" && id.length > 0 && id.length <= 160;

function boundedRecords(records, limit = SNAPSHOT_LIMIT) {
  const unique = new Map();
  const cap = Math.min(SNAPSHOT_LIMIT, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : SNAPSHOT_LIMIT));
  for (const item of records) {
    if (!validId(item?.id) || !["active", "waiting", "unconfirmed"].includes(item.status)) continue;
    unique.delete(item.id);
    unique.set(item.id, { id: item.id, status: item.status, at: Number.isFinite(item.at) && item.at >= 0 ? item.at : 0 });
    if (unique.size > cap) unique.delete(unique.keys().next().value);
  }
  return [...unique.values()];
}

export function readTaskSnapshot(storage, key, limit = 200) {
  try {
    const value = JSON.parse(storage?.getItem?.(key) || "[]");
    if (!Array.isArray(value)) return [];
    return boundedRecords(value.map((item) => ({ id: item?.id, status: item?.status || "active", at: Number(item?.at) })), limit);
  } catch {
    return [];
  }
}

export function buildActiveTaskSnapshot(threads, statusType = (status) => threadStatusInfo(status).type, now = Date.now()) {
  return boundedRecords((threads || [])
    .filter((thread) => ["active", "waiting"].includes(statusType(thread.status)))
    .map((thread) => ({ id: thread.id, status: statusType(thread.status), at: now })));
}

export function reconcileTaskSnapshot(previous, current, threads) {
  const active = new Map((current || []).map((item) => [item.id, item.status]));
  const visible = new Map((threads || []).map((thread) => [thread.id, threadStatusInfo(thread.status).type]));
  const result = { stillRunning: [], waiting: [], inactive: [], errors: [], unconfirmed: [] };
  for (const item of previous || []) {
    const status = active.get(item.id) || visible.get(item.id);
    const bucket = { active: "stillRunning", waiting: "waiting", idle: "inactive", error: "errors" }[status] || "unconfirmed";
    result[bucket].push(item);
  }
  return result;
}

// Lists may be searched, archived, or paginated. Absence from one response is
// not a terminal result. Keep unresolved IDs bounded, without storing content.
export function mergeTaskSnapshot(previous, current, threads) {
  const { unconfirmed } = reconcileTaskSnapshot(previous, current, threads);
  return boundedRecords([...unconfirmed.map((item) => ({ ...item, status: "unconfirmed" })), ...current]);
}
