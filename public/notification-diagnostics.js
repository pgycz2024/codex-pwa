export const UNKNOWN_NOTIFICATION_LIMIT = 128;
export const UNKNOWN_NOTIFICATION_STORAGE_KEY = "codex-pwa-unknown-notifications";

function validMethod(value) {
  const method = String(value || "").trim();
  return method.length > 0 && method.length <= 180 ? method : "";
}

function validRecord(value) {
  const count = Number(value?.count);
  const lastAt = Number(value?.lastAt);
  if (!Number.isFinite(count) || count < 1 || !Number.isFinite(lastAt) || lastAt < 0) return null;
  return { count: Math.min(Math.floor(count), 1_000_000), lastAt };
}

export function normalizeUnknownNotifications(value, limit = UNKNOWN_NOTIFICATION_LIMIT) {
  const source = value instanceof Map ? value : new Map(
    value && typeof value === "object" ? Object.entries(value) : [],
  );
  const entries = [];
  for (const [rawMethod, rawRecord] of source) {
    const method = validMethod(rawMethod);
    const record = validRecord(rawRecord);
    if (method && record) entries.push([method, record]);
  }
  entries.sort((left, right) => right[1].lastAt - left[1].lastAt);
  return new Map(entries.slice(0, Math.max(1, Math.floor(limit))));
}

export function readUnknownNotifications(storage, key = UNKNOWN_NOTIFICATION_STORAGE_KEY) {
  try {
    const raw = storage?.getItem(key);
    return normalizeUnknownNotifications(raw ? JSON.parse(raw) : null);
  } catch {
    try { storage?.removeItem(key); } catch {}
    return new Map();
  }
}

export function recordUnknownNotification(current, method, at = Date.now()) {
  const normalizedMethod = validMethod(method);
  const timestamp = Number(at);
  if (!normalizedMethod || !Number.isFinite(timestamp) || timestamp < 0) {
    return normalizeUnknownNotifications(current);
  }
  const next = normalizeUnknownNotifications(current);
  const previous = next.get(normalizedMethod);
  next.set(normalizedMethod, {
    count: Math.min((previous?.count || 0) + 1, 1_000_000),
    lastAt: timestamp,
  });
  return normalizeUnknownNotifications(next);
}

export function persistUnknownNotifications(storage, value, key = UNKNOWN_NOTIFICATION_STORAGE_KEY) {
  const normalized = normalizeUnknownNotifications(value);
  try {
    storage?.setItem(key, JSON.stringify(Object.fromEntries(normalized)));
  } catch {}
  return normalized;
}

export function summarizeUnknownNotifications(value, limit = 6) {
  const normalized = normalizeUnknownNotifications(value);
  const entries = [...normalized.entries()].slice(0, Math.max(1, Math.floor(limit)))
    .map(([method, record]) => ({ method, count: record.count, lastAt: record.lastAt }));
  return {
    methodCount: normalized.size,
    totalCount: [...normalized.values()].reduce((sum, record) => sum + record.count, 0),
    latestAt: entries[0]?.lastAt || 0,
    entries,
  };
}
