export const THREAD_LIST_MODES = new Set(["recent", "all", "archived"]);
export const THREAD_FILTERS = new Set(["all", "unread", "active", "waiting", "error", "idle", "saved", "unknown"]);
export const RECENT_THREAD_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export function threadRecencyEpoch(thread) {
  const value = Number(thread?.recencyAt ?? thread?.updatedAt ?? thread?.createdAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function isRecentThread(thread, now = Date.now() / 1000) {
  return threadRecencyEpoch(thread) >= now - RECENT_THREAD_WINDOW_SECONDS;
}

/**
 * Apply inbox filters without depending on DOM state. The caller supplies the
 * status classifier so this module remains compatible with server status
 * shapes while keeping filtering rules easy to test in isolation.
 */
export function matchesThreadFilter(thread, {
  filter = "all",
  project = "all",
  tag = "all",
  unreadThreads = new Set(),
  tagsByThread = new Map(),
  statusType = () => "",
} = {}) {
  if (project !== "all" && String(thread?.cwd || "") !== project) return false;
  if (tag !== "all" && !(tagsByThread.get(String(thread?.id || "")) || []).includes(tag)) return false;
  if (filter === "all") return true;
  if (filter === "unread") return unreadThreads.has(thread?.id);
  return statusType(thread?.status) === filter;
}
