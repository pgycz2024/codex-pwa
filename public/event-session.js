export const EVENT_CURSOR_STORAGE_KEY = "codex-pwa-last-event-id";

export function readStoredEventId(storage, key = EVENT_CURSOR_STORAGE_KEY) {
  try {
    const value = Number.parseInt(storage?.getItem?.(key) || "0", 10);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function persistEventId(storage, value, key = EVENT_CURSOR_STORAGE_KEY) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) return false;
  try {
    storage?.setItem?.(key, String(normalized));
    return true;
  } catch {
    return false;
  }
}

export function createEventDeduper(maxEntries = 1_024) {
  const ids = new Set();
  const order = [];
  return {
    has(value) {
      return ids.has(value);
    },
    add(value) {
      if (ids.has(value)) return false;
      ids.add(value);
      order.push(value);
      while (order.length > maxEntries) ids.delete(order.shift());
      return true;
    },
    size() {
      return ids.size;
    },
  };
}
