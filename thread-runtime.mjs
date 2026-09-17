import { uiText } from "./public/ui-copy.js";
import { ThreadMutationQueue } from "./thread-mutation-queue.mjs";

export function createThreadRuntime({
  getCodex,
  usesSharedDaemon,
  broadcast,
  invalidateRecovery
}) {
  const activeTurns = new Map();
  const ownedThreads = new Set();
  const releasingThreads = new Set();
  const threadMutationQueue = new ThreadMutationQueue();
  const releaseTimers = new Map();
  let recycleRetryTimer = null;
  const AUTO_RELEASE_DELAY_MS = 1_000;

  function clearThreadReleaseTimer(threadId) {
    const timer = releaseTimers.get(threadId);
    if (timer) clearTimeout(timer);
    releaseTimers.delete(threadId);
  }

  function resetThreadOwnership(status = null) {
    const threadIds = new Set([...ownedThreads, ...releasingThreads]);
    for (const timer of releaseTimers.values()) clearTimeout(timer);
    releaseTimers.clear();
    if (recycleRetryTimer) clearTimeout(recycleRetryTimer);
    recycleRetryTimer = null;
    activeTurns.clear();
    ownedThreads.clear();
    releasingThreads.clear();
    if (status) {
      for (const threadId of threadIds) {
        broadcast({ kind: "bridge/threadOwnership", threadId, status });
      }
    }
  }

  function markThreadOwned(threadId) {
    if (!threadId) return;
    clearThreadReleaseTimer(threadId);
    releasingThreads.delete(threadId);
    ownedThreads.add(threadId);
    broadcast({ kind: "bridge/threadOwnership", threadId, status: "owned" });
  }

  function forgetThreadOwnership(threadId, status = "released") {
    clearThreadReleaseTimer(threadId);
    activeTurns.delete(threadId);
    invalidateRecovery(threadId);
    ownedThreads.delete(threadId);
    releasingThreads.delete(threadId);
    broadcast({ kind: "bridge/threadOwnership", threadId, status });
  }

  function hasPendingThreadRequest(threadId) {
    return [...getCodex().serverRequests.values()].some((request) => request.params?.threadId === threadId);
  }

  function scheduleBridgeRecycle(reason = "handoff", delay = 750) {
    if (recycleRetryTimer) clearTimeout(recycleRetryTimer);
    recycleRetryTimer = setTimeout(() => {
      recycleRetryTimer = null;
      maybeRecycleBridge(reason).catch((error) => {
        console.warn(`[app-server] Unable to recycle bridge: ${error.message}`);
        scheduleBridgeRecycle(reason, 2_000);
      });
    }, delay);
  }

  async function maybeRecycleBridge(reason = "handoff") {
    if (usesSharedDaemon) return false;
    if (!releasingThreads.size) return false;
    if (activeTurns.size || getCodex().serverRequests.size || getCodex().pending.size || getCodex().recyclePromise) {
      scheduleBridgeRecycle(reason);
      return false;
    }
    await getCodex().recycle(reason);
    return true;
  }

  async function releaseThread(threadId, { reason = "manual", automatic = false } = {}) {
    clearThreadReleaseTimer(threadId);
    if (!ownedThreads.has(threadId)) {
      const recycled = releasingThreads.has(threadId) ? await maybeRecycleBridge(reason) : false;
      return { status: recycled ? "released" : releasingThreads.has(threadId) ? "releasing" : "notOwned", reason };
    }
    if (activeTurns.has(threadId) || hasPendingThreadRequest(threadId)) {
      if (automatic) {
        scheduleThreadRelease(threadId, 2_000, reason);
        return { status: "deferred", reason };
      }
      const error = new Error(uiText("taskRuntime.releaseThread.text"));
      error.statusCode = 409;
      throw error;
    }

    releasingThreads.add(threadId);
    broadcast({ kind: "bridge/threadOwnership", threadId, status: "releasing", reason });
    try {
      const result = await getCodex().request("thread/unsubscribe", { threadId });
      if (usesSharedDaemon) {
        getCodex().subscribedThreads.delete(threadId);
        getCodex().subscriptionSettings.delete(threadId);
        forgetThreadOwnership(threadId, "released");
        return {
          status: "released",
          unsubscribeStatus: result?.status || "unsubscribed",
          reason,
        };
      }
      ownedThreads.delete(threadId);
      const recycled = await maybeRecycleBridge(reason);
      return {
        status: recycled ? "released" : "deferred",
        unsubscribeStatus: result?.status || "unsubscribed",
        reason,
      };
    } catch (error) {
      releasingThreads.delete(threadId);
      ownedThreads.add(threadId);
      broadcast({ kind: "bridge/threadOwnership", threadId, status: "owned", error: error.message });
      throw error;
    }
  }

  function scheduleThreadRelease(threadId, delay = AUTO_RELEASE_DELAY_MS, reason = "idle") {
    if (!threadId || !ownedThreads.has(threadId)) return;
    clearThreadReleaseTimer(threadId);
    releaseTimers.set(threadId, setTimeout(() => {
      releaseTimers.delete(threadId);
      releaseThread(threadId, { reason, automatic: true }).catch((error) => {
        console.warn(`[app-server] Unable to release thread ${threadId}: ${error.message}`);
      });
    }, delay));
  }


  return { activeTurns, ownedThreads, releasingThreads, threadMutationQueue, clearThreadReleaseTimer, resetThreadOwnership, markThreadOwned, forgetThreadOwnership, hasPendingThreadRequest, releaseThread, scheduleThreadRelease };
}
