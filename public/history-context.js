import { reconcileChildren, captureReadingAnchor, restoreReadingAnchor, setText } from "./dom-reconcile.js";

export function createHistoryContextManager({
  state,
  elements,
  el,
  boundedWindow,
  formatAbsolute,
  historyNodePrompt,
  historyNodePreview,
  turnTimestamp,
  turnGroup,
  createTurnGroup,
  updateTurnGroup,
  dropRenderedItem,
  loadHistoryContextPage,
  returnToLatestConversation,
  renderKnownArtifacts,
  updateHistoryControls,
  scrollToBottom,
} = {}) {
  let viewScope = "";
  const savedUi = new Map();
  let renderSequence = 0;

  function historyWindowButton(direction, hiddenCount) {
    const shell = elements.messages.querySelector(`.history-window-nav[data-direction="${direction}"]`) || el("div", "history-window-nav");
    shell.dataset.direction = direction;
    let button = shell.querySelector("button");
    if (!button) {
      button = el("button");
      button.type = "button";
      button.addEventListener("click", () => shiftHistoryWindow(direction));
      shell.append(button);
    }
    setText(button, direction === "older"
        ? `查看更早的 ${Math.min(hiddenCount, state.historyWindow.size)} 个轮次（尚有 ${hiddenCount} 个）`
        : `查看较新的 ${Math.min(hiddenCount, state.historyWindow.size)} 个轮次（尚有 ${hiddenCount} 个）`,
    );
    return shell;
  }

  function historyContextBanner() {
    const existing = elements.messages.querySelector(".history-context-banner");
    if (existing) { updateHistoryContextBanner(); return existing; }
    const shell = el("section", "history-context-banner");
    const copy = el("div", "history-context-copy");
    copy.append(
      el("strong", "", "历史节点上下文"),
      el("span", "", state.historyContext.deferredUpdates ? "任务已有新进展" : "正在查看所选节点附近的完整记录"),
    );
    const latest = el("button", "", state.historyContext.deferredUpdates ? "查看最新进展" : "返回最新对话");
    latest.type = "button";
    latest.addEventListener("click", async () => {
      latest.disabled = true;
      const restored = await returnToLatestConversation();
      if (!restored && latest.isConnected) latest.disabled = false;
    });
    shell.append(copy, latest);
    return shell;
  }

  function updateHistoryContextBanner() {
    if (!state.historyContext.active) return;
    const banner = elements.messages.querySelector(".history-context-banner");
    if (!banner) return;
    const copy = banner.querySelector(".history-context-copy > span");
    const latest = banner.querySelector("button");
    if (copy) setText(copy, state.historyContext.deferredUpdates
      ? "任务已有新进展"
      : "正在查看所选节点附近的完整记录");
    if (latest) setText(latest, state.historyContext.deferredUpdates ? "查看最新进展" : "返回最新对话");
  }

  function markHistoryContextUpdated() {
    if (!state.historyContext.active) return;
    state.historyContext.deferredUpdates = true;
    updateHistoryContextBanner();
    if (!elements.messages.querySelector(".history-context-banner") && state.selectedThread?.turns?.length) {
      renderHistoryWindow({ focusTurnId: state.historyContext.targetTurnId });
    }
  }

  function historyContextBoundary(direction) {
    const cursor = direction === "older" ? state.historyContext.olderCursor : state.historyContext.newerCursor;
    if (!cursor) return null;
    const existing = elements.messages.querySelector(`.history-context-boundary[data-direction="${direction}"]`);
    if (existing) return existing;
    const shell = el("div", "history-context-boundary");
    shell.dataset.direction = direction;
    const button = el("button", "", direction === "older" ? "↑ 加载更早上下文" : "加载较新上下文 ↓");
    button.type = "button";
    button.disabled = Boolean(state.historyContext.loadingDirection);
    button.addEventListener("click", () => loadHistoryContextPage(direction));
    shell.append(button);
    return shell;
  }

  function historyContextTurn(turn, index, targetIndex, group = createTurnGroup(turn)) {
    group.classList.toggle("history-context-target", turn.id === state.historyContext.targetTurnId);
    if (Math.abs(index - targetIndex) <= 1) return group;
    const wrapper = group.parentElement?.classList.contains("history-context-turn") ? group.parentElement : el("details", "history-context-turn");
    let summary = wrapper.querySelector(":scope > summary");
    if (!summary) {
      summary = el("summary", "history-context-turn-summary");
      summary.append(el("span", "history-context-turn-direction"), el("span", "history-context-turn-prompt"), el("span", "history-context-turn-time"));
      wrapper.append(summary);
    }
    const prompt = historyNodePreview(historyNodePrompt(turn), 150) || "无文字 Prompt";
    const timestamp = turnTimestamp(turn);
    setText(summary.querySelector(".history-context-turn-direction"), index < targetIndex ? "更早" : "较新");
    setText(summary.querySelector(".history-context-turn-prompt"), prompt);
    setText(summary.querySelector(".history-context-turn-time"), timestamp ? formatAbsolute(timestamp) : "");
    if (group.parentElement !== wrapper) wrapper.append(group);
    return wrapper;
  }

  function rememberTurnUi(group) {
    const items = new Map();
    for (const [id, node] of state.itemNodes) {
      if (!group.contains(node.element)) continue;
      const details = [...(node.element.matches("details") ? [node.element] : []), ...node.element.querySelectorAll("details")];
      if (details.length || node.expanded) items.set(id, { type: node.type, expanded: Boolean(node.expanded), open: details.map((detail) => detail.open) });
    }
    savedUi.set(group.dataset.turnId, { open: Boolean(group.closest(".history-context-turn")?.open), items });
  }

  function restoreTurnUi(group, shell) {
    const saved = savedUi.get(group.dataset.turnId);
    if (!saved) return;
    if (shell.matches("details.history-context-turn")) shell.open = saved.open;
    for (const [id, ui] of saved.items) {
      const node = state.itemNodes.get(id);
      if (!node || node.type !== ui.type || !group.contains(node.element)) continue;
      const details = [...(node.element.matches("details") ? [node.element] : []), ...node.element.querySelectorAll("details")];
      details.forEach((detail, index) => { if (index < ui.open.length) detail.open = ui.open[index]; });
      // Restoring UI must never fetch remote output or issue a task action.
      if (ui.expanded && !node.expanded && !node.remoteTruncated) {
        const toggle = node.toggle || node.element.querySelector(".long-reply-toggle");
        toggle?.click();
      }
    }
  }

  function renderHistoryWindow({ start = null, focusTurnId = null, scroll = "preserve", focusFirst = false } = {}) {
    const turns = state.selectedThread?.turns || [];
    if (!turns.length) return;
    const size = state.historyWindow.size;
    const windowRange = boundedWindow(turns.length, size, start);
    const { enabled, start: nextStart, end: nextEnd } = windowRange;
    const context = state.historyContext.active ? state.historyContext : null;
    const threadId = state.selectedThread.id;
    const scope = `${threadId}:${context?.sequence ?? "latest"}`;
    const changedScope = scope !== viewScope;
    if (changedScope) { savedUi.clear(); viewScope = scope; }
    const allIds = new Set(turns.map((turn) => turn.id));
    for (const id of savedUi.keys()) if (!allIds.has(id)) savedUi.delete(id);
    const previousGroups = new Map([...elements.messages.querySelectorAll(".turn-group")].map((group) => [group.dataset.turnId, group]));
    if (changedScope && context) previousGroups.clear();
    for (const group of previousGroups.values()) if (allIds.has(group.dataset.turnId)) rememberTurnUi(group);
    const active = document.activeElement;
    const hadFocus = elements.messages.contains(active);
    const anchor = captureReadingAnchor(elements.messages, [...elements.messages.querySelectorAll(".message-row, .activity-card, .history-context-turn > summary")]);
    const previousTop = elements.messages.scrollTop;
    state.loadedTurnIds.clear();

    const children = [];
    if (context) {
      children.push(historyContextBanner());
      const feedback = !changedScope && elements.messages.querySelector(".history-context-feedback");
      if (feedback) children.push(feedback);
      const olderBoundary = historyContextBoundary("older");
      if (olderBoundary) children.push(olderBoundary);
    }
    if (nextStart > 0) children.push(historyWindowButton("older", nextStart));
    const targetIndex = context ? turns.findIndex((turn) => turn.id === context.targetTurnId) : -1;
    turns.slice(nextStart, nextEnd).forEach((turn, offset) => {
      const index = nextStart + offset;
      state.loadedTurnIds.add(turn.id);
      let group = previousGroups.get(turn.id);
      const reused = Boolean(group);
      if (group) updateTurnGroup(group, turn);
      else group = createTurnGroup(turn);
      const shell = context ? historyContextTurn(turn, index, targetIndex, group) : group;
      if (!reused) restoreTurnUi(group, shell);
      children.push(shell);
    });
    if (nextEnd < turns.length) children.push(historyWindowButton("newer", turns.length - nextEnd));
    if (context) {
      const newerBoundary = historyContextBoundary("newer");
      if (newerBoundary) children.push(newerBoundary);
      children.push(elements.historyControls);
    } else {
      children.unshift(elements.historyControls);
    }
    reconcileChildren(elements.messages, children);
    for (const [id, node] of state.itemNodes) {
      if (!String(id).startsWith("local-") && !elements.messages.contains(node.element)) dropRenderedItem(id);
    }
    state.historyWindow = { ...state.historyWindow, enabled, start: nextStart, end: nextEnd };
    elements.messages.classList.toggle("virtual-history", enabled);
    elements.messages.classList.toggle("history-context", Boolean(context));
    if (state.historyContext.active && !elements.messages.querySelector(".history-context-banner")) {
      elements.messages.insertBefore(historyContextBanner(), elements.messages.firstChild);
    }
    renderKnownArtifacts();
    updateHistoryControls();
    const banner = elements.messages.querySelector(".history-context-banner");
    if (banner) elements.messages.style.setProperty("--history-banner-height", `${banner.getBoundingClientRect().height}px`);

    const sequence = ++renderSequence;
    requestAnimationFrame(() => {
      if (sequence !== renderSequence || state.selectedThread?.id !== threadId || (context && state.historyContext !== context)) return;
      if (focusFirst || (hadFocus && !active.isConnected)) {
        const shell = children.find((node) => node.matches(".turn-group, .history-context-turn"));
        (shell?.querySelector(":scope > summary") || shell)?.focus({ preventScroll: true });
      }
      if (focusTurnId) {
        const group = turnGroup(focusTurnId);
        group?.scrollIntoView({ behavior: "instant", block: "start" });
      } else if (scroll === "bottom") {
        scrollToBottom(true);
      } else if (scroll === "top") {
        elements.messages.scrollTo({ top: 0, behavior: "instant" });
      } else {
        if (anchor?.node.isConnected) restoreReadingAnchor(elements.messages, anchor);
        else elements.messages.scrollTo({ top: Math.min(previousTop, elements.messages.scrollHeight), behavior: "instant" });
      }
    });
  }

  function shiftHistoryWindow(direction) {
    if (!state.historyWindow.enabled) return;
    const { start, end, size } = state.historyWindow;
    const overlap = Math.min(20, Math.floor(size / 4));
    const nextStart = direction === "older"
      ? Math.max(0, start - size + overlap)
      : Math.min(Math.max(0, (state.selectedThread?.turns?.length || 0) - size), end - overlap);
    renderHistoryWindow({ start: nextStart, scroll: "top", focusFirst: true });
  }

  return {
    historyContextBanner,
    updateHistoryContextBanner,
    markHistoryContextUpdated,
    historyContextBoundary,
    historyContextTurn,
    renderHistoryWindow,
    shiftHistoryWindow,
  };
}
