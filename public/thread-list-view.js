import { uiText } from "./ui-copy.js";
import { reconcileChildren, setText, captureReadingAnchor, restoreReadingAnchor } from "./dom-reconcile.js";

export function createThreadListViewManager({
  state,
  elements,
  el,
  basename,
  threadTitle,
  threadPreview,
  statusInfo,
  sourceLabel,
  threadRecencyEpoch,
  normalizeEpochSeconds,
  formatRelative,
  formatAbsolute,
  isRecentThread,
  matchesThreadFilter,
  tagsForThread,
  openThread,
  openThreadActionMenu,
  openTagDialog,
  openFloatingMenu,
  togglePin,
  openRenameDialog,
  copyThreadId,
  archiveThread,
  unarchiveThread,
  closeAllMenus,
} = {}) {
  const cards = new Map();
  const groupsByPath = new Map();

  function syncOptions(select, entries, value) {
    const existing = new Map([...select.options].map((option) => [option.value, option]));
    const options = entries.map(([key, label, title = ""]) => {
      const option = existing.get(key) || el("option");
      option.value = key;
      setText(option, label);
      if (option.title !== title) option.title = title;
      return option;
    });
    reconcileChildren(select, options);
    if (select.value !== value) select.value = value;
  }
  function syncListModeTabs() {
    const mode = state.threadListMode;
    const tabs = [
      [elements.recentTab, mode === "recent", "recentTab"],
      [elements.allHistoryTab, mode === "all", "allHistoryTab"],
      [elements.archivedTab, mode === "archived", "archivedTab"],
    ];
    for (const [tab, active, id] of tabs) {
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.setAttribute("tabindex", active ? "0" : "-1");
      if (active) elements.threadList.setAttribute("aria-labelledby", id);
    }
  }

  function syncProjectFilterOptions() {
    const current = state.threadProjectFilter;
    const paths = [...new Set(state.threads.map((thread) => String(thread.cwd || "")).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" }));
    const entries = [["all", uiText("html.threadProjectFilter.text")], ...paths.map((path) => [path, basename(path), path])];
    if (current !== "all" && !paths.includes(current)) {
      entries.push([current, uiText("list.syncTagFilterOptions.push", basename(current)), current]);
    }
    syncOptions(elements.threadProjectFilter, entries, current);
  }

  function syncTagFilterOptions() {
    const current = state.threadTagFilter;
    const tags = [...new Set([...state.threadTags.values()].flat())]
      .sort((left, right) => left.localeCompare(right, "zh-CN", { sensitivity: "base" }));
    const entries = [["all", uiText("html.threadTagFilter.text")], ...tags.map((tag) => [tag, tag])];
    if (current !== "all" && !tags.includes(current)) {
      entries.push([current, uiText("list.syncTagFilterOptions.push", current)]);
    }
    syncOptions(elements.threadTagFilter, entries, current);
  }

  function wireThreadLongPress(main, card, currentThread) {
    let timer = null;
    let startX = 0;
    let startY = 0;
    let suppressClick = false;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
      card.classList.remove("long-pressing");
    };
    main.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      card.classList.add("long-pressing");
      timer = setTimeout(() => {
        timer = null;
        suppressClick = true;
        card.classList.remove("long-pressing");
        navigator.vibrate?.(12);
        if (card.isConnected) openThreadActionMenu(currentThread());
      }, 520);
    });
    main.addEventListener("pointermove", (event) => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
    });
    for (const eventName of ["pointerup", "pointercancel", "pointerleave"]) main.addEventListener(eventName, cancel);
    main.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      cancel();
      openThreadActionMenu(currentThread());
    });
    main.addEventListener("click", (event) => {
      if (suppressClick) {
        event.preventDefault();
        suppressClick = false;
        return;
      }
      const thread = currentThread();
      openThread(thread.id, { archived: Boolean(thread.archived) });
    });
    return cancel;
  }

  function visibleThreadCandidates() {
    const scoped = state.threadListMode === "recent"
      ? state.threads.filter((thread) => isRecentThread(thread))
      : state.threads;
    return scoped.filter((thread) => matchesThreadFilter(thread, {
      filter: state.threadFilter,
      project: state.threadProjectFilter,
      tag: state.threadTagFilter,
      unreadThreads: state.unreadThreads,
      tagsByThread: state.threadTags,
      statusType: (status) => statusInfo(status).type,
    }));
  }

  function syncThreadBatchActions() {
    const selectedCount = state.selectedThreadIds.size;
    elements.threadBatchActions.classList.toggle("hidden", selectedCount === 0);
    if (!selectedCount) return;
    elements.threadBatchActions.setAttribute("aria-label", uiText("list.syncThreadBatchActions.setAttribute", selectedCount));
    elements.markSelectedThreadsReadButton.textContent = uiText("list.syncThreadBatchActions.textContent4", selectedCount);
    elements.archiveSelectedThreadsButton.textContent = state.threadListMode === "archived"
      ? uiText("list.syncThreadBatchActions.textContent3", selectedCount)
      : uiText("list.syncThreadBatchActions.textContent2", selectedCount);
    const candidates = visibleThreadCandidates();
    const allSelected = candidates.length > 0 && candidates.every((thread) => state.selectedThreadIds.has(thread.id));
    elements.selectVisibleThreadsButton.textContent = allSelected ? uiText("list.syncThreadBatchActions.textContent") : uiText("html.selectVisibleThreadsButton.text");
  }

  function toggleThreadSelection(threadId, selected) {
    if (selected) state.selectedThreadIds.add(threadId);
    else state.selectedThreadIds.delete(threadId);
    syncThreadBatchActions();
    renderThreads();
  }

  function createThreadCard(thread) {
    const card = el("article", "thread-card");
    card.dataset.threadId = thread.id;
    const record = { card, thread };
    const select = el("input", "thread-select");
    select.type = "checkbox";
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("change", () => toggleThreadSelection(thread.id, select.checked));
    const selectTarget = el("label", "thread-select-target");
    selectTarget.append(select);
    const main = el("button", "thread-main");
    main.type = "button";
    const titleLine = el("div", "thread-title-line");
    const statusDot = el("span", "thread-status");
    statusDot.setAttribute("aria-hidden", "true");
    const pin = el("span", "thread-pin", "◆");
    pin.setAttribute("aria-label", uiText("list.createThreadCard.setAttribute"));
    const title = el("span", "thread-title");
    const unread = el("span", "thread-unread-badge", uiText("list.createThreadCard.el"));
    const preview = el("span", "thread-preview");
    const meta = el("span", "thread-meta");
    const statusText = el("span");
    const origin = el("span");
    meta.append(statusText, el("span", "", "·"), origin);
    main.append(titleLine, preview, meta);
    record.cancelPress = wireThreadLongPress(main, card, () => record.thread);
    const time = el("time", "thread-time");
    const menu = el("div", "thread-menu");
    const menuButton = el("button", "thread-menu-button", "•••");
    menuButton.type = "button";
    menuButton.setAttribute("aria-haspopup", "menu");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const thread = record.thread;
      const actions = [
      { label: state.pinned.has(thread.id) ? uiText("common.unpin") : uiText("common.pin"), handler: () => togglePin(thread.id) },
      { label: uiText("common.rename"), handler: () => openRenameDialog(thread) },
      { label: uiText("html.tagDialogTitle.text"), handler: () => openTagDialog(thread) },
      { label: uiText("html.copyThreadIdButton.text"), handler: () => copyThreadId(thread.id) },
      {
        label: thread.archived ? uiText("common.restore") : uiText("common.archive"),
        danger: !thread.archived,
        handler: () => thread.archived ? unarchiveThread(thread.id) : archiveThread(thread.id),
      },
      ];
      openFloatingMenu(menuButton, card, actions);
    });
    menu.append(menuButton);
    card.append(selectTarget, main, time, menu);
    return Object.assign(record, { select, main, titleLine, statusDot, pin, title, unread, preview, statusText, origin, time, menuButton, tags: new Map() });
  }

  function updateThreadCard(record, thread) {
    record.thread = thread;
    record.card.classList.toggle("active", state.selectedThread?.id === thread.id);
    record.select.checked = state.selectedThreadIds.has(thread.id);
    record.select.setAttribute("aria-label", uiText("list.updateThreadCard.setAttribute2", threadTitle(thread)));
    record.menuButton.setAttribute("aria-label", uiText("list.updateThreadCard.setAttribute", threadTitle(thread)));
    const status = statusInfo(thread.status);
    record.statusDot.className = `thread-status ${status.type}`;
    setText(record.title, threadTitle(thread));
    setText(record.preview, threadPreview(thread));
    setText(record.statusText, status.label);
    setText(record.origin, thread.gitInfo?.branch || sourceLabel(thread));
    const tags = tagsForThread(thread.id);
    for (const tag of record.tags.keys()) if (!tags.includes(tag)) record.tags.delete(tag);
    const tagNodes = tags.map((tag) => {
      if (!record.tags.has(tag)) record.tags.set(tag, el("span", "thread-tag", tag));
      return record.tags.get(tag);
    });
    reconcileChildren(record.titleLine, [record.statusDot, ...(state.pinned.has(thread.id) ? [record.pin] : []),
      record.title, ...tagNodes, ...(state.unreadThreads.has(thread.id) ? [record.unread] : [])]);
    const activityAt = normalizeEpochSeconds(thread.recencyAt || thread.updatedAt);
    setText(record.time, formatRelative(activityAt));
    record.time.title = formatAbsolute(activityAt);
    if (activityAt) { record.time.dataset.epoch = String(activityAt); record.time.dateTime = new Date(activityAt * 1000).toISOString(); }
    else { delete record.time.dataset.epoch; record.time.removeAttribute("datetime"); }
  }

  function renderThreads() {
    if (state.floatingMenu) {
      state.threadRenderPending = true;
      return;
    }
    state.threadRenderPending = false;
    const active = document.activeElement;
    const previousCards = [...elements.threadList.querySelectorAll(".thread-card")];
    const focusedIndex = previousCards.findIndex((card) => card.contains(active));
    const anchor = captureReadingAnchor(elements.threadList, previousCards);
    syncProjectFilterOptions();
    syncTagFilterOptions();
    const visibleIds = new Set(visibleThreadCandidates().map((thread) => thread.id));
    for (const selectedId of state.selectedThreadIds) {
      if (!visibleIds.has(selectedId)) state.selectedThreadIds.delete(selectedId);
    }
    syncThreadBatchActions();
    const visibleThreads = visibleThreadCandidates();
    for (const [id, record] of cards) if (!visibleIds.has(id)) { record.cancelPress(); cards.delete(id); }
    if (!visibleThreads.length) {
      let emptyCopy;
      if (state.query) emptyCopy = [uiText("list.renderThreads.text22"), uiText("directory.renderDirectoryList.el2")];
      else if (state.threadFilter === "unread") emptyCopy = [uiText("list.renderThreads.text21"), uiText("list.renderThreads.text20")];
      else if (state.threadFilter === "waiting") emptyCopy = [uiText("list.renderThreads.text19"), uiText("list.renderThreads.text18")];
      else if (state.threadFilter === "active") emptyCopy = [uiText("list.renderThreads.text17"), uiText("list.renderThreads.text16")];
      else if (state.threadFilter === "error") emptyCopy = [uiText("list.renderThreads.text15"), uiText("list.renderThreads.text14")];
      else if (state.threadFilter === "idle") emptyCopy = [uiText("list.renderThreads.text13"), uiText("list.renderThreads.text12")];
      else if (state.threadFilter === "saved") emptyCopy = [uiText("list.renderThreads.text11"), uiText("list.renderThreads.text10")];
      else if (state.threadFilter === "unknown") emptyCopy = [uiText("list.renderThreads.text9"), uiText("list.renderThreads.text8")];
      else if (state.threadListMode === "recent") emptyCopy = [uiText("list.renderThreads.text7"), uiText("list.renderThreads.text6")];
      else if (state.threadListMode === "archived") emptyCopy = [uiText("list.renderThreads.text5"), uiText("list.renderThreads.text4")];
      else emptyCopy = [uiText("list.renderThreads.text3"), uiText("list.renderThreads.text2")];
      const empty = el("div", "empty-list");
      empty.append(el("strong", "", emptyCopy[0]), el("p", "", emptyCopy[1]));
      reconcileChildren(elements.threadList, [empty]);
      groupsByPath.clear();
      if (focusedIndex >= 0) elements.threadList.focus({ preventScroll: true });
      return;
    }
    const sorted = [...visibleThreads].sort((a, b) => {
      const pinDelta = Number(state.pinned.has(b.id)) - Number(state.pinned.has(a.id));
      return pinDelta || threadRecencyEpoch(b) - threadRecencyEpoch(a);
    });
    const groups = new Map();
    for (const thread of sorted) {
      const key = thread.cwd || uiText("list.renderThreads.text");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(thread);
    }
    const groupNodes = [];
    for (const [cwd, threads] of groups) {
      if (!groupsByPath.has(cwd)) {
        const group = el("section", "thread-group");
        const heading = el("div", "thread-group-heading");
        const name = el("span", "", basename(cwd));
        name.title = cwd;
        const count = el("small");
        heading.append(name, count);
        group.append(heading);
        groupsByPath.set(cwd, { group, heading, count });
      }
      const { group, heading, count } = groupsByPath.get(cwd);
      setText(count, threads.length);
      const nodes = threads.map((thread) => {
        if (!cards.has(thread.id)) cards.set(thread.id, createThreadCard(thread));
        const record = cards.get(thread.id);
        updateThreadCard(record, thread);
        return record.card;
      });
      reconcileChildren(group, [heading, ...nodes]);
      groupNodes.push(group);
    }
    reconcileChildren(elements.threadList, groupNodes);
    for (const path of groupsByPath.keys()) if (!groups.has(path)) groupsByPath.delete(path);
    if (focusedIndex >= 0 && document.activeElement !== active) {
      const currentCards = [...elements.threadList.querySelectorAll(".thread-card")];
      const next = currentCards[Math.min(focusedIndex, currentCards.length - 1)];
      const selector = active.matches(".thread-select") ? ".thread-select" : active.matches(".thread-menu-button") ? ".thread-menu-button" : ".thread-main";
      (active.isConnected ? active : next?.querySelector(selector) || elements.threadList).focus({ preventScroll: true });
    }
    restoreReadingAnchor(elements.threadList, anchor);
  }

  return {
    syncListModeTabs,
    syncProjectFilterOptions,
    syncTagFilterOptions,
    visibleThreadCandidates,
    syncThreadBatchActions,
    toggleThreadSelection,
    renderThreads,
  };
}
