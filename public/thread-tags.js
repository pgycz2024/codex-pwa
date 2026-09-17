export const THREAD_TAGS_STORAGE_KEY = "codex-pwa-thread-tags";
export const MAX_THREAD_TAGS = 5;
export const MAX_THREAD_TAG_LENGTH = 24;

export function normalizeThreadTags(values) {
  const source = Array.isArray(values) ? values : String(values || "").split(",");
  return [...new Set(source
    .map((value) => String(value || "").trim().slice(0, MAX_THREAD_TAG_LENGTH))
    .filter(Boolean))].slice(0, MAX_THREAD_TAGS);
}

export function readStoredThreadTags(storage, key = THREAD_TAGS_STORAGE_KEY) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(key) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([id, tags]) => id && Array.isArray(tags))
      .map(([id, tags]) => [id, normalizeThreadTags(tags)])
      .filter(([, tags]) => tags.length));
  } catch {
    return {};
  }
}

export function persistThreadTags(storage, values, key = THREAD_TAGS_STORAGE_KEY) {
  const entries = values instanceof Map ? values.entries() : Object.entries(values || {});
  const normalized = Object.fromEntries([...entries]
    .map(([id, tags]) => [String(id), normalizeThreadTags(tags)])
    .filter(([id, tags]) => id && tags.length));
  try {
    if (Object.keys(normalized).length) storage?.setItem?.(key, JSON.stringify(normalized));
    else storage?.removeItem?.(key);
  } catch {}
  return normalized;
}
