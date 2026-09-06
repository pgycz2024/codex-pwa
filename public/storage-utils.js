export function readStoredStringArray(storage, key) {
  try {
    const value = JSON.parse(storage?.getItem?.(key) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item) => typeof item === "string");
  } catch {
    try { storage?.removeItem?.(key); } catch {}
    return [];
  }
}
