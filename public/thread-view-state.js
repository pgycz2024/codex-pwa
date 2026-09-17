export const THREAD_VIEW_STATE_KEY = "codex-pwa-thread-view-state";
export const THREAD_VIEW_STATE_LIMIT = 100;

function validId(value) {
  const id = String(value || "").trim();
  return id.length > 0 && id.length <= 180 ? id : "";
}

function normalizeEntry(value) {
  const ratio = Number(value?.ratio);
  const at = Number(value?.at);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return null;
  return {
    ratio,
    bottom: Boolean(value?.bottom),
    at: Number.isFinite(at) && at > 0 ? at : 0,
  };
}

export function normalizeThreadViewState(value, limit = THREAD_VIEW_STATE_LIMIT) {
  const source = value && typeof value === "object" ? value : {};
  const entries = [];
  for (const [rawId, rawEntry] of Object.entries(source)) {
    const id = validId(rawId);
    const entry = normalizeEntry(rawEntry);
    if (id && entry) entries.push([id, entry]);
  }
  entries.sort((left, right) => right[1].at - left[1].at);
  return Object.fromEntries(entries.slice(0, Math.max(1, Math.floor(limit))));
}

export function readThreadViewState(storage, key = THREAD_VIEW_STATE_KEY) {
  try {
    const raw = storage?.getItem(key);
    return normalizeThreadViewState(raw ? JSON.parse(raw) : null);
  } catch {
    try { storage?.removeItem(key); } catch {}
    return {};
  }
}

export function writeThreadViewState(storage, value, key = THREAD_VIEW_STATE_KEY) {
  const normalized = normalizeThreadViewState(value);
  try { storage?.setItem(key, JSON.stringify(normalized)); } catch {}
  return normalized;
}

export function rememberThreadView(value, threadId, { ratio = 0, bottom = false, at = Date.now() } = {}) {
  const id = validId(threadId);
  const numericRatio = Number(ratio);
  if (!id || !Number.isFinite(numericRatio)) return normalizeThreadViewState(value);
  const next = normalizeThreadViewState(value);
  next[id] = {
    ratio: Math.min(1, Math.max(0, numericRatio)),
    bottom: Boolean(bottom),
    at: Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : 0,
  };
  return normalizeThreadViewState(next);
}
