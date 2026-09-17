import { TASK_NOTICE_COPY, turnOutcomeCopy } from "./status-display.js";
import { approvalRequestId, sameApprovalRequest } from "./approval-state.js";

export function createEventConnectionManager({
  state,
  sessionStorageRef = globalThis.sessionStorage,
  environment = globalThis,
  setConnection,
  runVisibleRecovery,
  showToast,
  persistEventId,
  handleNotification,
  markThreadUnread,
  updateThreadStatus,
  sendBrowserNotification,
  announceStatus = () => {},
  renderApprovals,
  updateChatActions,
  updateTurnControls,
  renderAccessRoots,
  renderInfoPanel,
  isQuestionRequest,
} = {}) {
  const online = () => environment.navigator?.onLine !== false;
  const now = () => Date.now();
  let recoveryTask = null;
  let recoveryEpoch = 0;
  let recoveryRetryTimer = null;
  let recoveryRetryAttempt = 0;
  let recoveryFailureShown = false;
  let recoveryFollowup = false;

  function invalidateRecovery() {
    recoveryEpoch += 1;
    recoveryTask = null;
    recoveryFollowup = false;
    clearTimeout(recoveryRetryTimer);
    recoveryRetryTimer = null;
    clearTimeout(state.eventRecoveryTimer);
    state.eventRecoveryTimer = null;
  }

  function recover({ fresh = false } = {}) {
    const events = state.eventSource;
    const generation = state.eventGeneration;
    const epoch = recoveryEpoch;
    const current = () => state.auth.authenticated && state.eventSource === events
      && state.eventGeneration === generation && recoveryEpoch === epoch;
    if (!events || !state.auth.authenticated) return Promise.resolve(false);
    if (recoveryTask) {
      if (fresh) recoveryFollowup = true;
      return recoveryTask;
    }
    clearTimeout(recoveryRetryTimer);
    recoveryRetryTimer = null;
    clearTimeout(state.eventRecoveryTimer);
    state.eventRecoveryTimer = null;
    const retry = () => {
      if (!current() || !online() || environment.document?.visibilityState === "hidden") return;
      const delay = Math.min(30_000, 3000 * (2 ** Math.min(recoveryRetryAttempt++, 4)));
      recoveryRetryTimer = setTimeout(() => {
        recoveryRetryTimer = null;
        if (current()) void recover();
      }, delay);
    };
    const task = Promise.resolve().then(() => runVisibleRecovery()).then((synced) => {
      if (!current()) return false;
      if (recoveryFollowup) return false;
      if (synced !== true) {
        state.eventRecoveryPending = true;
        retry();
        return false;
      }
      recoveryRetryAttempt = 0;
      recoveryFailureShown = false;
      if (state.eventRecoveryPending) {
        state.eventRecoveryTimer = setTimeout(() => {
          state.eventRecoveryTimer = null;
          if (!current() || !online() || environment.document?.visibilityState === "hidden") return;
          const count = state.eventRecoveryCount;
          const message = state.eventRecoveryGap
            ? "网络已恢复；部分实时更新已超出回放窗口，任务状态已重新同步"
            : count ? `网络已恢复，已接收 ${count} 条更新，任务状态已同步` : "网络已恢复，任务状态已同步";
          state.eventRecoveryPending = false;
          state.eventRecoveryGap = false;
          state.eventRecoveryCount = 0;
          showToast(message, 5200);
        }, 700);
      }
      return true;
    }).catch(() => {
      if (!current()) return false;
      state.eventRecoveryPending = true;
      if (!recoveryFailureShown) {
        showToast("实时连接已建立，但任务状态尚未同步；页面会自动重试。", 6200);
        recoveryFailureShown = true;
      }
      retry();
      return false;
    }).finally(() => {
      if (recoveryTask !== task) return;
      recoveryTask = null;
      const followup = recoveryFollowup && current();
      recoveryFollowup = false;
      if (followup) void recover();
    });
    recoveryTask = task;
    return task;
  }

  function stop() {
    invalidateRecovery();
    recoveryRetryAttempt = 0;
    recoveryFailureShown = false;
    state.eventGeneration += 1;
    clearTimeout(state.eventReconnectTimer);
    state.eventReconnectTimer = null;
    state.eventReconnectAttempt = 0;
    state.eventRecoveryPending = false;
    state.eventRecoveryGap = false;
    state.eventRecoveryCount = 0;
    clearTimeout(state.eventRecoveryTimer);
    state.eventRecoveryTimer = null;
    clearInterval(state.eventHeartbeatTimer);
    state.eventHeartbeatTimer = null;
    state.eventLastHeartbeatAt = 0;
    state.eventSource?.close();
    state.eventSource = null;
  }

  function schedule(generation = state.eventGeneration, { immediate = false } = {}) {
    if (generation !== state.eventGeneration || !state.auth.authenticated) return;
    clearTimeout(state.eventReconnectTimer);
    const attempt = immediate ? 0 : state.eventReconnectAttempt;
    const delay = immediate ? 0 : Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)));
    state.eventReconnectTimer = setTimeout(() => {
      state.eventReconnectTimer = null;
      if (generation !== state.eventGeneration || !state.auth.authenticated) return;
      connect({ generation });
    }, delay);
  }

  function connect({ generation = null } = {}) {
    if (!state.auth.authenticated) return;
    if (generation === null) {
      state.eventGeneration += 1;
      generation = state.eventGeneration;
    }
    if (generation !== state.eventGeneration) return;
    invalidateRecovery();
    clearTimeout(state.eventReconnectTimer);
    state.eventReconnectTimer = null;
    state.eventSource?.close();
    state.eventSource = null;
    clearInterval(state.eventHeartbeatTimer);
    state.eventHeartbeatTimer = null;
    if (!online()) {
      state.offlineSince ||= now();
      setConnection("offline");
      schedule(generation);
      return;
    }
    const reconnecting = state.eventReconnectAttempt > 0;
    if (reconnecting) {
      state.eventRecoveryPending = true;
      state.eventRecoveryGap = false;
      state.eventRecoveryCount = 0;
    }
    setConnection(reconnecting ? "reconnecting" : "connecting");
    const eventUrl = state.lastEventId
      ? `/api/events?after=${encodeURIComponent(String(state.lastEventId))}`
      : "/api/events";
    const EventSourceCtor = environment.EventSource;
    if (typeof EventSourceCtor !== "function") {
      setConnection("error", "当前浏览器不支持实时事件流");
      return;
    }
    const events = new EventSourceCtor(eventUrl);
    state.eventSource = events;
    state.eventLastHeartbeatAt = now();
    state.eventHeartbeatTimer = setInterval(() => {
      if (generation !== state.eventGeneration || state.eventSource !== events) return;
      if (now() - state.eventLastHeartbeatAt <= 60_000) return;
      events.close();
      state.eventSource = null;
      invalidateRecovery();
      clearInterval(state.eventHeartbeatTimer);
      state.eventHeartbeatTimer = null;
      state.eventReconnectAttempt += 1;
      setConnection(online() ? "reconnecting" : "offline");
      schedule(generation);
    }, 20_000);
    events.onopen = () => {
      if (generation !== state.eventGeneration || state.eventSource !== events) return;
      state.eventReconnectAttempt = 0;
      state.offlineSince = null;
      state.eventLastHeartbeatAt = now();
      setConnection("ready");
      void recover();
    };
    events.onerror = () => {
      if (generation !== state.eventGeneration || state.eventSource !== events) return;
      events.close();
      state.eventSource = null;
      invalidateRecovery();
      clearInterval(state.eventHeartbeatTimer);
      state.eventHeartbeatTimer = null;
      state.eventReconnectAttempt += 1;
      if (!online()) {
        state.offlineSince ||= now();
        setConnection("offline");
      } else {
        setConnection("reconnecting");
      }
      schedule(generation);
    };
    events.onmessage = (event) => {
      if (generation !== state.eventGeneration || state.eventSource !== events) return;
      if (event.lastEventId) {
        const eventId = Number.parseInt(event.lastEventId, 10);
        if (Number.isSafeInteger(eventId) && eventId > 0) {
          if (!state.eventDeduper.add(eventId)) return;
          state.lastEventId = Math.max(state.lastEventId, eventId);
          persistEventId(sessionStorageRef, state.lastEventId);
        }
      }
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.kind === "bridge/heartbeat") {
        state.eventLastHeartbeatAt = now();
        return;
      }
      if (state.eventRecoveryPending && (payload.kind === "app-server/notification" || payload.kind === "app-server/request")) {
        state.eventRecoveryCount += 1;
      }
      if (payload.kind === "bridge/status") setConnection(payload.status, payload.error);
      else if (payload.kind === "bridge/replayGap") {
        state.eventRecoveryGap = true;
        state.eventRecoveryPending = true;
        void recover({ fresh: true });
      } else if (payload.kind === "bridge/taskRecovered") {
        const copy = turnOutcomeCopy(payload.status);
        if (copy) {
          announceStatus(TASK_NOTICE_COPY.recovered);
          markThreadUnread(payload.threadId);
          sendBrowserNotification({ threadId: payload.threadId,
            title: copy.title,
            body: TASK_NOTICE_COPY.recovered,
          });
        }
        // A recovered old turn must never clear a newer live turn or replace its
        // messages. Refresh authoritative state through the existing flow.
        void recover();
      } else if (payload.kind === "bridge/threadOwnership") {
        if (payload.status === "owned") {
          state.ownedThreads.add(payload.threadId);
          state.releasingThreads.delete(payload.threadId);
        } else if (payload.status === "releasing") {
          state.ownedThreads.add(payload.threadId);
          state.releasingThreads.add(payload.threadId);
        } else {
          state.ownedThreads.delete(payload.threadId);
          state.releasingThreads.delete(payload.threadId);
        }
        if (state.selectedThread?.id === payload.threadId) {
          updateChatActions();
          updateTurnControls();
        }
      } else if (payload.kind === "bridge/accessRootsChanged") {
        state.roots = (payload.roots || []).map((root) => root.path || root).filter(Boolean);
        state.accessRoots.roots = payload.roots || [];
        renderAccessRoots();
        renderInfoPanel();
      } else if (payload.kind === "app-server/notification") handleNotification(payload.message);
      else if (payload.kind === "app-server/request") {
        const requestId = approvalRequestId(payload.requestId);
        if (requestId === null) return;
        announceStatus(isQuestionRequest(payload.method) ? "有任务需要你的回答" : "有任务等待审批");
        const previous = state.approvals.get(requestId);
        state.approvals.set(requestId, payload.requestToken && sameApprovalRequest(previous, payload) ? previous : payload);
        state.approvalRevision += 1;
        const requestThreadId = payload.params?.threadId;
        if (requestThreadId) {
          markThreadUnread(requestThreadId);
          sendBrowserNotification({
            threadId: requestThreadId,
            title: TASK_NOTICE_COPY.waiting.title,
            body: isQuestionRequest(payload.method) ? "后台任务需要你的回答" : "后台任务需要审批",
          });
          if (requestThreadId !== state.selectedThread?.id) {
            updateThreadStatus(requestThreadId, { type: "active", activeFlags: [isQuestionRequest(payload.method) ? "waitingOnUserInput" : "waitingOnApproval"] });
            showToast("另一个任务正在等待你的操作");
          }
        }
        renderApprovals();
      } else if (payload.kind === "bridge/log" && payload.level === "error") {
        console.warn(payload.message);
      }
    };
  }

  return { connect, stop, schedule, recover };
}
