import { normalizeNotificationMethod } from "./notification-methods.js";
import { threadStatusInfo as statusInfo, STATUS_LABELS, TASK_NOTICE_COPY, turnOutcomeCopy } from "./status-display.js";
import { resolveMessageTiming } from "./message-time.js";
import { UNKNOWN_NOTIFICATION_STORAGE_KEY, recordUnknownNotification, persistUnknownNotifications } from "./notification-diagnostics.js";

export function createNotificationHandler({
  state,
  elements,
  storage,
  updateChatHeader,
  renderThreads,
  renderInfoPanel,
  markThreadUnread,
  sendBrowserNotification,
  markHistoryContextUpdated,
  applyGoalState,
  scheduleThreadRefresh,
  clearSelectedThread,
  renderApprovals,
  shouldFollowOutput,
  announceStatus,
  clearThreadWriteConflict,
  turnGroup,
  updateTurnControls,
  updateChatActions,
  syncTurnOutcome,
  createTurnOutcome,
  loadThreads,
  loadThreadArtifacts,
  storeItemTiming,
  appendBoundedLiveText,
  boundedLiveText,
  scheduleAssistantMessageRender,
  renderCommand,
  scheduleCommandOutputRender,
  renderReasoning,
  renderFileChange,
  renderItem,
  notificationTurnId,
  renderChangesPanel,
  renderPlan,
  isContextNotice,
  renderTurnNotice,
  scrollToBottom,
  maxLiveCommandChars
}) {
  function updateThreadStatus(threadId, status) {
    const listed = state.threads.find((thread) => thread.id === threadId);
    if (listed) listed.status = status;
    if (state.selectedThread?.id === threadId) {
      state.selectedThread.status = status;
      updateChatHeader();
    }
    renderThreads();
  }

  function historyContextDefersNotification(method) {
    return method.startsWith("item/")
      || method === "contextCompaction"
      || method === "thread/compacted"
      || method === "turn/plan/updated"
      || method === "warning"
      || method === "error"
      || method === "guardianWarning";
  }

  const KNOWN_NOTIFICATION_METHODS = new Set([
    "thread/status/changed", "thread/name/updated", "thread/goal/updated", "thread/goal/cleared",
    "thread/started", "thread/unarchived", "thread/archived", "thread/deleted",
    "turn/started", "turn/completed", "turn/diff/updated", "turn/plan/updated",
    "item/agentMessage/delta", "item/commandExecution/outputDelta", "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta", "item/fileChange/patchUpdated", "item/started", "item/completed",
    "contextCompaction", "thread/compacted", "thread/tokenUsage/updated",
    "warning", "error", "guardianWarning", "serverRequest/resolved",
  ]);

  function handleNotification(message) {
    const method = normalizeNotificationMethod(message?.method);
    const params = message?.params || {};
    const selectedId = state.selectedThread?.id;
    if (method && !KNOWN_NOTIFICATION_METHODS.has(method)) {
      state.unknownNotifications = recordUnknownNotification(state.unknownNotifications, method);
      persistUnknownNotifications(storage, state.unknownNotifications, UNKNOWN_NOTIFICATION_STORAGE_KEY);
      console.warn(`[app-server] 未识别通知：${method}`);
      if (selectedId) renderInfoPanel();
    }

    if (method === "thread/status/changed") {
      updateThreadStatus(params.threadId, params.status);
      const status = statusInfo(params.status);
      if (["active", "waiting", "error"].includes(status.type)) {
        markThreadUnread(params.threadId);
        if (["waiting", "error"].includes(status.type)) {
          sendBrowserNotification({
            threadId: params.threadId,
            ...TASK_NOTICE_COPY[status.type],
          });
        }
      }
      if (params.threadId === selectedId && state.historyContext.active) markHistoryContextUpdated();
      return;
    }
    if (method === "thread/name/updated") {
      const thread = state.threads.find((item) => item.id === params.threadId);
      const name = params.threadName || params.name;
      if (thread) thread.name = name;
      if (state.selectedThread?.id === params.threadId) state.selectedThread.name = name;
      updateChatHeader(); renderThreads(); return;
    }
    if (method === "thread/goal/updated") {
      if (params.threadId === selectedId) applyGoalState(params.threadId, { supported: true, goal: params.goal });
      return;
    }
    if (method === "thread/goal/cleared") {
      if (params.threadId === selectedId) applyGoalState(params.threadId, { supported: true, goal: null });
      return;
    }
    if (method === "thread/started" || method === "thread/unarchived") {
      scheduleThreadRefresh();
      return;
    }
    if (method === "thread/archived" || method === "thread/deleted") {
      state.threads = state.threads.filter((thread) => thread.id !== params.threadId);
      if (selectedId === params.threadId) clearSelectedThread();
      renderThreads(); return;
    }
    if (method === "serverRequest/resolved") {
      const requestId = String(params.requestId ?? params.id ?? "");
      const pending = state.approvals.get(requestId);
      if (requestId && (!pending?.params?.threadId || pending.params.threadId === params.threadId)) {
        state.approvals.delete(requestId);
        // Invalidate an in-flight status snapshot even when the request has not
        // reached this browser yet. A resolved background request must stay gone.
        state.approvalRevision += 1;
        renderApprovals();
      }
      return;
    }
    if (params.threadId) {
      if (method === "turn/started" || method === "turn/completed") {
        markThreadUnread(params.threadId);
        if (method === "turn/completed") {
          const copy = turnOutcomeCopy(params.turn?.status);
          if (!copy) {
            scheduleThreadRefresh();
            return;
          }
          sendBrowserNotification({
            threadId: params.threadId,
            title: copy.title,
            body: copy.body,
          });
        }
      }
      if (params.threadId !== selectedId) return;
    }

    const browsingHistory = state.historyContext.active && state.historyContext.threadId === selectedId;
    if (browsingHistory && historyContextDefersNotification(method)) {
      if (method === "turn/plan/updated") state.plan = params;
      markHistoryContextUpdated();
      return;
    }

    const follow = shouldFollowOutput();
    if (method === "turn/started") {
      announceStatus("Codex 正在处理当前任务");
      if (params.threadId) {
        state.ownedThreads.add(params.threadId);
        state.releasingThreads.delete(params.threadId);
        clearThreadWriteConflict(params.threadId);
      }
      state.activeTurnId = params.turn?.id || state.activeTurnId;
      if (browsingHistory) markHistoryContextUpdated();
      else turnGroup(state.activeTurnId, { create: Boolean(state.activeTurnId) });
      if (state.selectedThread) state.selectedThread.status = { type: "active", activeFlags: [] };
      updateTurnControls(); updateChatActions(); updateChatHeader(); renderThreads();
    } else if (method === "turn/completed") {
      if (!state.activeTurnId || state.activeTurnId === params.turn?.id) {
        announceStatus(turnOutcomeCopy(params.turn?.status)?.announcement || STATUS_LABELS.unknown);
        clearThreadWriteConflict(params.threadId);
        state.activeTurnId = null;
        if (state.selectedThread) state.selectedThread.status = { type: "idle" };
      }
      const turn = params.turn;
      if (browsingHistory) {
        markHistoryContextUpdated();
      } else {
        const group = turn?.id ? turnGroup(turn.id) : null;
        if (group && turn) syncTurnOutcome(group, turn);
        else if (turn?.status === "failed") {
          const error = createTurnOutcome(turn);
          if (error) elements.messages.append(error);
        } else if (turn?.status === "interrupted") {
          const stopped = createTurnOutcome(turn);
          if (stopped) elements.messages.append(stopped);
        }
      }
      updateTurnControls(); updateChatActions(); updateChatHeader();
      loadThreads({ silent: true }).catch(() => {});
      if (params.threadId && !browsingHistory) {
        setTimeout(() => loadThreadArtifacts(params.threadId).catch(() => {}), 500);
      }
    } else if (method === "item/agentMessage/delta") {
      const turnId = params.turnId || state.activeTurnId;
      if (turnId) state.itemTurns.set(params.itemId, turnId);
      if (params.itemId) storeItemTiming(params.itemId, resolveMessageTiming({
        role: "assistant", previous: state.itemTimings.get(params.itemId), params, phase: "started",
        emittedAtMs: message.emittedAtMs, observedAt: message.pwaReceivedAt, browserAt: Date.now(),
      }));
      const next = appendBoundedLiveText(state.itemText.get(params.itemId), params.delta);
      state.itemText.set(params.itemId, next.text);
      if (follow) state.streamFollowItems.add(params.itemId);
      scheduleAssistantMessageRender(params.itemId);
    } else if (method === "item/commandExecution/outputDelta") {
      let node = state.itemNodes.get(params.itemId);
      if (!node) {
        const turnId = params.turnId || state.activeTurnId;
        if (turnId) state.itemTurns.set(params.itemId, turnId);
        renderCommand(
          { id: params.itemId, command: "正在执行命令", status: "inProgress", aggregatedOutput: "" },
          turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages,
        );
        node = state.itemNodes.get(params.itemId);
      }
      if (node?.output) {
        const delta = String(params.delta || "");
        const next = appendBoundedLiveText(node.fullText, delta, maxLiveCommandChars);
        node.fullText = next.text;
        node.memoryTruncated ||= next.truncated;
        node.outputLength = Number(node.outputLength || 0) + delta.length;
        scheduleCommandOutputRender(params.itemId, node, follow);
      }
    } else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      let node = state.itemNodes.get(params.itemId);
      if (!node) {
        const turnId = params.turnId || state.activeTurnId;
        if (turnId) state.itemTurns.set(params.itemId, turnId);
        renderReasoning(
          { id: params.itemId, summary: [], content: [] },
          turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages,
        );
        node = state.itemNodes.get(params.itemId);
      }
      if (node?.content) {
        node.content.textContent = appendBoundedLiveText(node.content.textContent, params.delta).text;
      }
    } else if (method === "item/fileChange/patchUpdated") {
      const turnId = params.turnId || state.activeTurnId;
      if (turnId) state.itemTurns.set(params.itemId, turnId);
      renderFileChange(
        { id: params.itemId, changes: params.changes || [], status: "inProgress" },
        turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages,
      );
    } else if (method === "item/started") {
      const turnId = params.turnId || state.activeTurnId;

      renderItem(params.item, turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages, {
        turnId, timeEvent: { params, phase: "started", emittedAtMs: message.emittedAtMs, observedAt: message.pwaReceivedAt, browserAt: Date.now() },
      });
    } else if (method === "item/completed") {
      const item = params.item;
      if (item?.type === "agentMessage") {
        state.itemText.set(item.id, boundedLiveText(item.text || state.itemText.get(item.id) || "").text);
      }
      const turnId = params.turnId || state.activeTurnId;

      renderItem(item, turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages, {
        turnId, timeEvent: { params, phase: "completed", emittedAtMs: message.emittedAtMs, observedAt: message.pwaReceivedAt, browserAt: Date.now() },
      });
    } else if (method === "contextCompaction" || method === "thread/compacted") {
      const turnId = notificationTurnId(params);
      const item = {
        id: params.itemId || params.id || "",
        type: "contextCompaction",
        status: params.status || "completed",
      };
      renderItem(item, turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages, { turnId });
    } else if (method === "turn/diff/updated") {
      state.rawDiff = params.diff || "";
      renderChangesPanel();
    } else if (method === "turn/plan/updated") {
      state.plan = params;
      renderPlan(params);
    } else if (method === "thread/tokenUsage/updated") {
      state.tokenUsage = params.tokenUsage;
      renderInfoPanel();
    } else if (method === "warning" || method === "error" || method === "guardianWarning") {
      const messageText = params.message || params.error?.message || JSON.stringify(params);
      const contextNotice = isContextNotice(messageText);
      const kind = contextNotice ? "context-warning" : method === "error" ? "error" : "warning";
      const turnId = notificationTurnId(params);
      const noticeId = params.id || params.warningId || params.error?.id || "";
      renderTurnNotice(messageText, { turnId, kind, id: noticeId });
    }
    if (follow) requestAnimationFrame(() => scrollToBottom(true));
  }


  return { handleNotification, updateThreadStatus };
}
