import { setText } from "./dom-reconcile.js";
import { createClientMessageId } from "./message-reconcile.js";

export function createMessageViewManager({
  state,
  elements,
  el,
  normalizeUserMessageText,
  reconcilePendingUserMessage,
  resolveMessageTiming,
  applyMessageTiming,
  clearOutcomeUnknown,
  createMessageRow,
  placeNodeInContainer,
  userMessageText,
  turnGroup,
  renderMarkdown,
  longReplyPresentation,
  copyText,
  showToast,
  suppressRedundantGeneratedArtifacts,
  scrollToBottom,
  streamRenderInterval = 90,
} = {}) {
  function renderUserMessage(item, container = elements.messages, options = {}) {
    const text = userMessageText(item);
    if (!text) return null;
    const itemId = String(item.id || "");
    const timeOptions = { item, turn: options.turn, role: "user", ...options.timeEvent,
      pendingAt: options.timestampEstimated ? options.timestamp : 0 };
    let timing = resolveMessageTiming({ ...timeOptions, previous: state.itemTimings.get(itemId) });
    const existing = itemId ? state.itemNodes.get(itemId) : null;
    if (existing?.type === "user") {
      setText(existing.body, text);
      existing.element.classList.remove("optimistic");
      clearOutcomeUnknown(existing.element);
      applyMessageTiming(existing.element, itemId, timing, "user");
      placeNodeInContainer(existing.element, container);
      return existing.element;
    }

    if (itemId && !itemId.startsWith("local-")) {
      const pendingNode = reconcilePendingUserMessage({
        pendingMessages: state.pendingUserMessages,
        itemNodes: state.itemNodes,
        itemTurns: state.itemTurns,
        itemTimings: state.itemTimings,
        threadId: state.selectedThread?.id || null,
        itemId,
        text,
        clientId: item.clientId,
      });
      if (pendingNode) {
        setText(pendingNode.body, text);
        pendingNode.element.classList.remove("optimistic");
        clearOutcomeUnknown(pendingNode.element);
        pendingNode.element.dataset.itemId = itemId;
        timing = resolveMessageTiming({ ...timeOptions, previous: state.itemTimings.get(itemId) });
        applyMessageTiming(pendingNode.element, itemId, timing, "user");
        placeNodeInContainer(pendingNode.element, container);
        return pendingNode.element;
      }
    }

    const { row, body } = createMessageRow("user");
    body.textContent = text;
    applyMessageTiming(row, itemId, timing, "user");
    if (itemId) row.dataset.itemId = itemId;
    container.append(row);
    if (itemId) state.itemNodes.set(itemId, { type: "user", element: row, body });
    if (itemId && options.turnId) state.itemTurns.set(itemId, options.turnId);
    return row;
  }

  function renderAssistantBody(body, text, { streaming = false, node = null } = {}) {
    // Copy text is updated separately, so compare against the last actual body
    // render. Finalizing a stream still needs its anchors and folded controls.
    if (node?.renderedText === text && node.renderedStreaming === streaming) return;
    body.classList.remove("long-reply", "long-reply-collapsed", "long-reply-expanded");
    renderMarkdown(body, text, { anchorPrefix: streaming ? "" : node?.id });
    if (node) { node.renderedText = text; node.renderedStreaming = streaming; }
    const presentation = longReplyPresentation(text, node?.expanded);
    if (streaming || !presentation.collapsible) return;
    const expanded = presentation.expanded;
    const toggle = el("button", "long-reply-toggle", presentation.buttonLabel);
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.addEventListener("click", () => {
      if (node) node.expanded = !node.expanded;
      const nextExpanded = Boolean(node?.expanded);
      body.classList.toggle("long-reply-collapsed", !nextExpanded);
      body.classList.toggle("long-reply-expanded", nextExpanded);
      toggle.textContent = nextExpanded ? "收起完整回复" : "展开完整回复";
      toggle.setAttribute("aria-expanded", String(nextExpanded));
    });
    body.classList.add("long-reply", expanded ? "long-reply-expanded" : "long-reply-collapsed");
    body.append(toggle);
  }

  function ensureAssistantCopyAction(node, text) {
    if (!node?.element) return;
    let action = node.element.querySelector(".message-copy");
    if (!action) {
      action = el("button", "message-copy", "复制回复");
      action.type = "button";
      action.setAttribute("aria-label", "复制 Codex 回复");
      action.addEventListener("click", async () => {
        const copied = await copyText(node.text || "");
        showToast(copied ? "回复已复制" : "复制回复失败，请长按文本复制", copied ? 2200 : 5200);
      });
      node.element.append(action);
    }
    node.text = String(text || "");
    action.disabled = !node.text;
  }

  function renderOptimisticUserMessage(text, { turnId = null,
    clientId = state.protocol?.bridgeCapabilities?.clientMessageCorrelation === true ? createClientMessageId() : null,
  } = {}) {
    const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const container = turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages;
    const row = renderUserMessage({ id, content: [{ type: "text", text }] }, container, {
      turnId,
      timestamp: Date.now(),
      timestampEstimated: true,
    });
    if (!row) return null;
    row.classList.add("optimistic");
    state.pendingUserMessages.push({
      id,
      clientId,
      threadId: state.selectedThread?.id || null,
      turnId,
      text: normalizeUserMessageText(text),
    });
    return { id, clientId, element: row };
  }

  function assignOptimisticMessageTurn(messageId, turnId) {
    if (!messageId || !turnId) return;
    const pending = state.pendingUserMessages.find((message) => message.id === messageId);
    if (pending) pending.turnId = turnId;
    state.itemTurns.set(messageId, turnId);
    const node = state.itemNodes.get(messageId);
    placeNodeInContainer(node?.element, turnGroup(turnId, { create: true }));
  }

  function discardOptimisticMessage(messageId) {
    if (!messageId) return;
    const index = state.pendingUserMessages.findIndex((message) => message.id === messageId);
    if (index >= 0) state.pendingUserMessages.splice(index, 1);
    state.itemNodes.get(messageId)?.element?.remove();
    state.itemNodes.delete(messageId);
    state.itemTurns.delete(messageId);
    state.itemTimings.delete(messageId);
  }

  function renderAssistantMessage(itemId, text, streaming = false, container = elements.messages, options = {}) {
    if (!streaming) {
      const timer = state.streamRenderTimers.get(itemId);
      if (timer) clearTimeout(timer);
      state.streamRenderTimers.delete(itemId);
      state.streamFollowItems.delete(itemId);
    }
    const existing = state.itemNodes.get(itemId);
    const timing = resolveMessageTiming({ role: "assistant", item: options.item, turn: options.turn,
      previous: state.itemTimings.get(itemId), ...options.timeEvent });
    if (existing?.type === "assistant") {
      ensureAssistantCopyAction(existing, text);
      renderAssistantBody(existing.body, text, { streaming, node: existing });
      existing.element.classList.toggle("streaming", streaming);
      existing.element.setAttribute("aria-busy", String(streaming));
      applyMessageTiming(existing.element, itemId, timing, "assistant");
      placeNodeInContainer(existing.element, container);
      suppressRedundantGeneratedArtifacts(container);
      return existing.element;
    }
    const { row, body } = createMessageRow("assistant");
    row.classList.toggle("streaming", streaming);
    row.setAttribute("aria-busy", String(streaming));
    const node = { id: itemId, type: "assistant", element: row, body, expanded: false, text: String(text || "") };
    renderAssistantBody(body, text, { streaming, node });
    ensureAssistantCopyAction(node, text);
    applyMessageTiming(row, itemId, timing, "assistant");
    container.append(row);
    state.itemNodes.set(itemId, node);
    if (options.turnId) state.itemTurns.set(itemId, options.turnId);
    suppressRedundantGeneratedArtifacts(container);
    return row;
  }

  function scheduleAssistantMessageRender(itemId) {
    if (state.streamRenderTimers.has(itemId)) return;
    state.streamRenderTimers.set(itemId, setTimeout(() => {
      state.streamRenderTimers.delete(itemId);
      const text = state.itemText.get(itemId) || "";
      const turnId = state.itemTurns.get(itemId) || state.activeTurnId;
      renderAssistantMessage(
        itemId,
        text,
        true,
        turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages,
        { turnId },
      );
      if (state.streamFollowItems.delete(itemId)) requestAnimationFrame(() => scrollToBottom(true));
    }, streamRenderInterval));
  }

  return {
    renderUserMessage,
    renderAssistantBody,
    ensureAssistantCopyAction,
    renderOptimisticUserMessage,
    assignOptimisticMessageTurn,
    discardOptimisticMessage,
    renderAssistantMessage,
    scheduleAssistantMessageRender,
  };
}
