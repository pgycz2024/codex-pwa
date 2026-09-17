import { uiText } from "./ui-copy.js";
import { reconcileChildren, setText } from "./dom-reconcile.js";

export function createHistoryNodesManager({
  state,
  elements,
  threadApi,
  el,
  formatAbsolute,
  fixedVirtualRange,
  userMessageText,
  focusHistoryNode,
  closeAllMenus,
  showLoadingToast,
  finishLoadingToast,
  showToast,
  maxNodes = 5_000,
  maxNodeTextChars = 16_000,
  rowHeight = 74,
} = {}) {
  const rows = new Map();
  let visibleNodes = [];
  let tabStopId = null;
  const rowResizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleHistoryNodesRender) : null;

  function resetHistoryNodes(threadId = null) {
    if (state.historyNodes?.renderFrame) cancelAnimationFrame(state.historyNodes.renderFrame);
    elements.historyNodesLoading?.classList.add("hidden");
    elements.historyNodesList?.classList.remove("focus-loading");
    if (elements.historyNodesSearch) elements.historyNodesSearch.disabled = false;
    rows.clear();
    rowResizeObserver?.disconnect();
    visibleNodes = [];
    tabStopId = null;
    state.historyNodes = {
      threadId,
      data: [],
      nextCursor: null,
      error: "",
      loading: false,
      loadingAll: false,
      focusLoading: false,
      complete: false,
      memoryLimited: false,
      renderFrame: 0,
      rangeStart: -1,
      rangeEnd: -1,
    };
  }

  function historyNodePrompt(turn) {
    const item = (turn?.items || []).find((candidate) => candidate?.type === "userMessage");
    const input = Array.isArray(turn?.input)
      ? turn.input.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n")
      : "";
    return (userMessageText(item)
      || (typeof turn?.prompt === "string" ? turn.prompt : "")
      || (typeof turn?.input === "string" ? turn.input : "")
      || input).trim();
  }

  function historyNodePreview(text, limit = 180) {
    const paragraph = String(text || "")
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n/u)[0]
      .replace(/\s+/gu, " ")
      .trim();
    return paragraph.length > limit ? `${paragraph.slice(0, limit - 1)}…` : paragraph;
  }

  function turnTimestamp(turn) {
    for (const key of ["createdAt", "startedAt", "updatedAt", "completedAt", "created_at", "started_at", "updated_at", "completed_at"]) {
      const value = Number(turn?.[key]);
      if (Number.isFinite(value) && value > 0) return value > 1e12 ? value / 1000 : value;
    }
    return 0;
  }

  function appendHistoryNodes(turns, { pageCursor = null } = {}) {
    const nodes = state.historyNodes;
    const known = new Set(nodes.data.map((node) => node.id));
    for (const turn of turns || []) {
      if (nodes.data.length >= maxNodes) return true;
      if (!turn?.id || known.has(turn.id)) continue;
      const text = historyNodePrompt(turn).slice(0, maxNodeTextChars);
      if (!text) continue;
      nodes.data.push({ id: turn.id, turn, text, preview: historyNodePreview(text), timestamp: turnTimestamp(turn), pageCursor });
      known.add(turn.id);
    }
    return false;
  }

  function renderHistoryNodes() {
    const nodes = state.historyNodes;
    const query = elements.historyNodesSearch.value.trim().toLocaleLowerCase("zh-CN");
    const visible = query
      ? nodes.data.filter((node) => `${node.text}\n${node.id}`.toLocaleLowerCase("zh-CN").includes(query))
      : nodes.data;
    visibleNodes = visible;
    const focused = elements.historyNodesRows.contains(document.activeElement) ? document.activeElement : null;
    const focusedIndex = visible.findIndex((node) => rows.get(node.id)?.button === focused);
    setText(elements.historyNodesStatus, nodes.data.length
      ? uiText("historyNodes.renderHistoryNodes.setText3", visible.length, nodes.data.length, nodes.memoryLimited ? uiText("historyNodes.renderHistoryNodes.setText2") : nodes.complete ? uiText("historyNodes.renderHistoryNodes.setText") : "")
      : "");
    const initialLoading = !query && nodes.data.length === 0 && (nodes.loading || nodes.loadingAll);
    if (!visible.length) {
      const empty = el("div", "history-nodes-empty");
      if (initialLoading) {
        empty.classList.add("history-nodes-loading");
        empty.append(el("span", "spinner"), el("strong", "", uiText("historyNodes.renderHistoryNodes.el6")));
      } else if (!query && nodes.error) {
        empty.classList.add("history-nodes-error");
        empty.append(el("strong", "", uiText("historyNodes.renderHistoryNodes.el5")), el("span", "", uiText("historyNodes.renderHistoryNodes.el4", nodes.error)));
      } else {
        empty.append(el("strong", "", query ? uiText("historyNodes.renderHistoryNodes.el3") : uiText("historyNodes.renderHistoryNodes.el2")), el("span", "", query ? uiText("directory.renderDirectoryList.el2") : uiText("historyNodes.renderHistoryNodes.el")));
      }
      elements.historyNodesList.setAttribute("aria-busy", String(initialLoading || nodes.focusLoading));
      elements.historyNodesCanvas.classList.add("empty");
      elements.historyNodesCanvas.style.height = "100%";
      elements.historyNodesRows.style.transform = "";
      elements.historyNodesRows.replaceChildren(empty);
      rows.clear();
      rowResizeObserver?.disconnect();
      tabStopId = null;
      if (focused) elements.historyNodesSearch.focus({ preventScroll: true });
      nodes.rangeStart = -1;
      nodes.rangeEnd = -1;
      return;
    }
    elements.historyNodesList.setAttribute("aria-busy", String(nodes.focusLoading));
    elements.historyNodesCanvas.classList.remove("empty");
    let sample = rows.values().next().value?.button;
    let probe = null;
    if (!sample?.isConnected) {
      probe = el("button", "history-node");
      probe.style.visibility = "hidden";
      probe.setAttribute("aria-hidden", "true");
      elements.historyNodesRows.append(probe);
      sample = probe;
    }
    const sampleHeight = sample.getBoundingClientRect().height;
    const measuredHeight = sampleHeight > 0 ? sampleHeight + (parseFloat(getComputedStyle(sample).marginBottom) || 0) : rowHeight;
    probe?.remove();
    const previousHeight = rowHeight;
    const scrollTop = elements.historyNodesList.scrollTop;
    if (measuredHeight > 0) rowHeight = measuredHeight;
    elements.historyNodesCanvas.style.height = `${visible.length * rowHeight}px`;
    if (previousHeight !== rowHeight) elements.historyNodesList.scrollTo({ top: scrollTop * rowHeight / previousHeight, behavior: "instant" });
    const { start, end } = fixedVirtualRange({
      total: visible.length,
      scrollTop: elements.historyNodesList.scrollTop,
      rowHeight,
      viewportHeight: elements.historyNodesList.clientHeight || 464,
      overscan: 12,
    });
    nodes.rangeStart = start;
    nodes.rangeEnd = end;
    const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
    // Keep one focused row mounted when pointer scrolling moves it offscreen.
    // Absolute slots avoid rendering every intervening row in a long history.
    if (focusedIndex >= 0 && (focusedIndex < start || focusedIndex >= end)) indices.push(focusedIndex);
    indices.sort((a, b) => a - b);
    if (focusedIndex >= 0) tabStopId = visible[focusedIndex].id;
    else {
      const firstVisible = Math.min(visible.length - 1, Math.floor(elements.historyNodesList.scrollTop / rowHeight));
      const lastVisible = Math.min(visible.length, Math.ceil((elements.historyNodesList.scrollTop + elements.historyNodesList.clientHeight - 16) / rowHeight));
      if (!visible.slice(firstVisible, lastVisible).some((node) => node.id === tabStopId)) tabStopId = visible[firstVisible]?.id;
    }
    const retained = new Set();
    const children = indices.map((index) => {
      const node = visible[index];
      retained.add(node.id);
      let record = rows.get(node.id);
      if (!record) {
        const slot = el("div", "history-node-slot");
        slot.setAttribute("role", "listitem");
        const button = el("button", "history-node");
        button.type = "button";
        const number = el("span", "history-node-index");
        const copy = el("span", "history-node-copy");
        const preview = el("span", "history-node-preview");
        const id = el("span", "history-node-meta");
        const time = el("span", "history-node-time");
        copy.append(preview, id, time);
        button.append(number, copy);
        slot.append(button);
        record = { slot, button, number, preview, id, time, node };
        button.addEventListener("click", () => {
          if (!state.historyNodes.focusLoading) focusHistoryNode(record.node);
        });
        rows.set(node.id, record);
        rowResizeObserver?.observe(button);
      }
      record.node = node;
      record.slot.style.top = `${index * rowHeight}px`;
      record.slot.setAttribute("aria-posinset", String(index + 1));
      record.slot.setAttribute("aria-setsize", String(nodes.complete ? visible.length : -1));
      record.button.title = node.text;
      record.button.dataset.historyNodeIndex = String(index);
      record.button.tabIndex = node.id === tabStopId ? 0 : -1;
      record.button.setAttribute("aria-disabled", String(nodes.focusLoading));
      setText(record.number, `#${index + 1}`);
      setText(record.preview, node.preview);
      setText(record.id, node.id);
      setText(record.time, node.timestamp ? formatAbsolute(node.timestamp) : "—");
      return record.slot;
    });
    elements.historyNodesRows.style.transform = "";
    reconcileChildren(elements.historyNodesRows, children);
    for (const [id, record] of rows) if (!retained.has(id)) {
      rowResizeObserver?.unobserve(record.button);
      rows.delete(id);
    }
    if (focused && focusedIndex < 0) rows.get(tabStopId)?.button.focus({ preventScroll: true });
  }

  elements.historyNodesRows.addEventListener("focusin", (event) => {
    const button = event.target.closest(".history-node");
    if (!button) return;
    tabStopId = visibleNodes[Number(button.dataset.historyNodeIndex)]?.id;
    for (const [id, record] of rows) record.button.tabIndex = id === tabStopId ? 0 : -1;
  });
  elements.historyNodesRows.addEventListener("focusout", scheduleHistoryNodesRender);
  elements.historyNodesRows.addEventListener("keydown", (event) => {
    const button = event.target.closest(".history-node");
    if (!button || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = Number(button.dataset.historyNodeIndex);
    const page = Math.max(1, Math.floor(elements.historyNodesList.clientHeight / rowHeight));
    const target = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: visibleNodes.length - 1,
      PageUp: index - page, PageDown: index + page }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    if (state.historyNodes.focusLoading) return;
    const next = Math.max(0, Math.min(visibleNodes.length - 1, target));
    const node = visibleNodes[next];
    if (!node) return;
    const list = elements.historyNodesList;
    const top = next * rowHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + rowHeight > list.scrollTop + list.clientHeight - 16) list.scrollTop = top + rowHeight - list.clientHeight + 16;
    renderHistoryNodes();
    rows.get(node.id)?.button.focus({ preventScroll: true });
    scheduleHistoryNodesRender();
  });

  function setHistoryNodesFocusLoading(loading, message = uiText("historyNodes.setHistoryNodesFocusLoading.text")) {
    const nodes = state.historyNodes;
    nodes.focusLoading = Boolean(loading);
    elements.historyNodesLoading.classList.toggle("hidden", !nodes.focusLoading);
    const messageNode = elements.historyNodesLoading.querySelector(".history-nodes-loading-message");
    if (messageNode) messageNode.textContent = message;
    elements.historyNodesList.classList.toggle("focus-loading", nodes.focusLoading);
    elements.historyNodesSearch.disabled = nodes.focusLoading;
    elements.historyNodesList.setAttribute("aria-busy", String(nodes.focusLoading || nodes.loading || nodes.loadingAll));
    updateHistoryNodesControls();
    renderHistoryNodes();
  }

  function scheduleHistoryNodesRender() {
    if (state.historyNodes.renderFrame) return;
    state.historyNodes.renderFrame = requestAnimationFrame(() => {
      state.historyNodes.renderFrame = 0;
      renderHistoryNodes();
    });
  }

  async function loadHistoryNodesPage({ all = false } = {}) {
    const threadId = state.selectedThread?.id;
    if (!threadId) return;
    if (state.historyNodes.threadId !== threadId) resetHistoryNodes(threadId);
    const nodes = state.historyNodes;
    if (nodes.loading || nodes.loadingAll || (nodes.complete && !all)) return;
    nodes.error = "";
    nodes.loading = true;
    nodes.loadingAll = all;
    const loadingToken = showLoadingToast(all ? uiText("historyNodes.loadHistoryNodesPage.showLoadingToast2") : uiText("historyNodes.loadHistoryNodesPage.showLoadingToast"));
    updateHistoryNodesControls();
    renderHistoryNodes();
    let cursor = nodes.nextCursor;
    let pages = 0;
    try {
      do {
        const params = new URLSearchParams({ limit: all ? "50" : "30" });
        if (cursor) params.set("cursor", cursor);
        const page = await threadApi.turns(threadId, params);
        if (state.selectedThread?.id !== threadId) return;
        const memoryLimited = appendHistoryNodes(page.data || [], { pageCursor: cursor });
        cursor = page.nextCursor || null;
        nodes.memoryLimited ||= memoryLimited;
        nodes.nextCursor = nodes.memoryLimited ? null : cursor;
        pages += 1;
        renderHistoryNodes();
        if (!all || nodes.memoryLimited) break;
        await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      } while (cursor && pages < 50);
      nodes.complete = !cursor && !nodes.memoryLimited;
      if (nodes.memoryLimited) showToast(uiText("historyNodes.loadHistoryNodesPage.showToast3", maxNodes.toLocaleString("zh-CN")), 5200);
      else if (all && cursor) showToast(uiText("historyNodes.loadHistoryNodesPage.showToast2"), 5200);
    } catch (error) {
      nodes.error = error.message || uiText("historyNodes.loadHistoryNodesPage.error");
      showToast(uiText("historyNodes.loadHistoryNodesPage.showToast", error.message), 5200);
    } finally {
      finishLoadingToast(loadingToken);
      if (state.historyNodes.threadId === threadId) {
        nodes.loading = false;
        nodes.loadingAll = false;
        updateHistoryNodesControls();
        renderHistoryNodes();
      }
    }
  }

  function updateHistoryNodesControls() {
    const nodes = state.historyNodes;
    const loading = nodes.loading || nodes.loadingAll || nodes.focusLoading;
    const canRetryInitialLoad = Boolean(nodes.error && !nodes.data.length && !nodes.complete);
    elements.historyNodesLoadMoreButton.disabled = loading || nodes.memoryLimited || (!nodes.nextCursor && !canRetryInitialLoad);
    elements.historyNodesLoadMoreButton.textContent = nodes.focusLoading ? uiText("historyNodes.updateHistoryNodesControls.textContent4") : nodes.loading && !nodes.loadingAll ? uiText("common.loading") : nodes.memoryLimited ? uiText("historyNodes.updateHistoryNodesControls.textContent2") : canRetryInitialLoad ? uiText("historyNodes.updateHistoryNodesControls.textContent5") : uiText("html.historyNodesLoadMoreButton.text");
    elements.historyNodesLoadAllButton.disabled = loading || nodes.memoryLimited || nodes.complete || !nodes.nextCursor;
    elements.historyNodesLoadAllButton.textContent = nodes.focusLoading ? uiText("historyNodes.updateHistoryNodesControls.textContent4") : nodes.loadingAll ? uiText("historyNodes.updateHistoryNodesControls.textContent3") : nodes.memoryLimited ? uiText("historyNodes.updateHistoryNodesControls.textContent2") : nodes.complete ? uiText("historyNodes.updateHistoryNodesControls.textContent") : uiText("html.historyNodesLoadAllButton.text");
  }

  async function openHistoryNodes() {
    const threadId = state.selectedThread?.id;
    if (!threadId) return;
    closeAllMenus();
    if (state.historyNodes.threadId !== threadId) resetHistoryNodes(threadId);
    elements.historyNodesSearch.value = "";
    elements.historyNodesList.scrollTop = 0;
    state.historyNodes.rangeStart = -1;
    state.historyNodes.rangeEnd = -1;
    if (!elements.historyNodesDialog.open) elements.historyNodesDialog.showModal();
    if (!state.historyNodes.data.length && !state.historyNodes.complete) await loadHistoryNodesPage();
    else { renderHistoryNodes(); updateHistoryNodesControls(); }
  }

  return {
    resetHistoryNodes,
    renderHistoryNodes,
    setHistoryNodesFocusLoading,
    scheduleHistoryNodesRender,
    loadHistoryNodesPage,
    updateHistoryNodesControls,
    openHistoryNodes,
    historyNodePrompt,
    historyNodePreview,
    turnTimestamp,
  };
}
