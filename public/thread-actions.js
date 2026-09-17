import { uiText } from "./ui-copy.js";
export function createThreadActionsManager({
  state,
  elements,
  api,
  renderThreads,
  updateChatActions,
  updateChatHeader,
  requestConfirmation,
  showToast,
  threadTitle,
  closeAllMenus,
  clearSelectedThread,
  persistUnreadThreads,
}) {
  function openRenameDialog(thread = state.selectedThread) {
    if (!thread) return;
    state.renameTargetId = thread.id;
    elements.renameInput.value = threadTitle(thread);
    elements.renameDialog.showModal();
    setTimeout(() => elements.renameInput.select(), 40);
  }

  function openThreadActionMenu(thread) {
    if (!thread) return;
    closeAllMenus();
    state.threadActionTargetId = thread.id;
    state.threadActionTargetArchived = Boolean(thread.archived);
    elements.threadActionTitle.textContent = threadTitle(thread);
    elements.actionPinThreadButton.textContent = state.pinned.has(thread.id) ? uiText("common.unpin") : uiText("common.pin");
    elements.actionArchiveThreadButton.textContent = thread.archived ? uiText("common.restore") : uiText("common.archive");
    if (!elements.threadActionDialog.open) elements.threadActionDialog.showModal();
  }

  async function togglePin(threadId) {
    const wasPinned = state.pinned.has(threadId);
    const isPinned = !wasPinned;
    if (isPinned) state.pinned.add(threadId);
    else state.pinned.delete(threadId);
    const thread = state.threads.find((item) => item.id === threadId);
    if (thread) thread.isPinned = isPinned;
    if (state.selectedThread?.id === threadId) state.selectedThread.isPinned = isPinned;
    updateChatActions();
    renderThreads();
    try {
      await api(`/api/threads/${encodeURIComponent(threadId)}/pin`, {
        method: "POST",
        body: JSON.stringify({ isPinned }),
      });
      state.legacyPins.delete(threadId);
      if (state.legacyPins.size) localStorage.setItem("codex-pwa-pins", JSON.stringify([...state.legacyPins]));
      else localStorage.removeItem("codex-pwa-pins");
    } catch (error) {
      if (wasPinned) state.pinned.add(threadId);
      else state.pinned.delete(threadId);
      if (thread) thread.isPinned = wasPinned;
      if (state.selectedThread?.id === threadId) state.selectedThread.isPinned = wasPinned;
      updateChatActions();
      renderThreads();
      showToast(uiText("tasks.togglePin.showToast", error.message));
    }
  }

  async function renameThread(event) {
    event.preventDefault();
    const name = elements.renameInput.value.trim();
    if (!name || !state.renameTargetId) return;
    const submit = elements.renameForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/api/threads/${encodeURIComponent(state.renameTargetId)}/name`, {
        method: "POST", body: JSON.stringify({ name }),
      });
      const thread = state.threads.find((item) => item.id === state.renameTargetId);
      if (thread) thread.name = name;
      if (state.selectedThread?.id === state.renameTargetId) state.selectedThread.name = name;
      updateChatHeader();
      renderThreads();
      elements.renameDialog.close();
      showToast(uiText("tasks.renameThread.showToast"));
    } catch (error) {
      showToast(error.message);
    } finally {
      submit.disabled = false;
    }
  }

  async function markSelectedThreadsRead() {
    const selected = [...state.selectedThreadIds];
    if (!selected.length) return;
    for (const threadId of selected) state.unreadThreads.delete(threadId);
    persistUnreadThreads();
    state.selectedThreadIds.clear();
    renderThreads();
    showToast(uiText("tasks.markSelectedThreadsRead.showToast", selected.length));
  }

  async function archiveSelectedThreads() {
    const selected = [...state.selectedThreadIds];
    if (!selected.length) return;
    const restoring = state.threadListMode === "archived";
    const confirmed = await requestConfirmation({
      eyebrow: restoring ? uiText("headings.restore_tasks") : uiText("headings.archive_tasks"),
      title: restoring ? uiText("tasks.archiveSelectedThreads.title2", selected.length) : uiText("tasks.archiveSelectedThreads.title", selected.length),
      message: restoring
        ? uiText("tasks.archiveSelectedThreads.message2")
        : uiText("tasks.archiveSelectedThreads.message"),
      confirmLabel: restoring ? uiText("common.confirmRestore") : uiText("common.confirmArchive"),
    });
    if (!confirmed) return;
    const failed = [];
    const changed = new Set();
    for (const threadId of selected) {
      try {
        await api(`/api/threads/${encodeURIComponent(threadId)}/${restoring ? "unarchive" : "archive"}`, {
          method: "POST", body: "{}",
        });
        changed.add(threadId);
      } catch (error) {
        failed.push(`${threadId}: ${error.message}`);
      }
    }
    state.threads = state.threads.filter((thread) => !changed.has(thread.id));
    for (const threadId of changed) state.selectedThreadIds.delete(threadId);
    if (changed.has(state.selectedThread?.id)) clearSelectedThread();
    renderThreads();
    if (failed.length) showToast(uiText("tasks.archiveSelectedThreads.showToast6", restoring ? uiText("common.restore") : uiText("common.archive"), changed.size, failed.length, failed[0]), 6200);
    else showToast(uiText("tasks.archiveSelectedThreads.showToast3", restoring ? uiText("tasks.archiveSelectedThreads.showToast2") : uiText("tasks.archiveSelectedThreads.showToast"), changed.size));
  }

  async function archiveThread(threadId) {
    const thread = state.threads.find((item) => item.id === threadId) || state.selectedThread;
    const confirmed = await requestConfirmation({
      eyebrow: uiText("headings.archive_tasks"),
      title: uiText("tasks.archiveThread.title"),
      message: uiText("tasks.archiveThread.message2", thread ? threadTitle(thread) : uiText("tasks.archiveThread.message"), thread?.cwd || ""),
      confirmLabel: uiText("common.confirmArchive"),
    });
    if (!confirmed) return;
    try {
      await api(`/api/threads/${encodeURIComponent(threadId)}/archive`, { method: "POST", body: "{}" });
      state.threads = state.threads.filter((thread) => thread.id !== threadId);
      if (state.selectedThread?.id === threadId) clearSelectedThread();
      renderThreads();
      showToast(uiText("tasks.archiveThread.showToast"));
    } catch (error) {
      showToast(error.message);
    }
  }

  async function unarchiveThread(threadId) {
    try {
      await api(`/api/threads/${encodeURIComponent(threadId)}/unarchive`, { method: "POST", body: "{}" });
      state.threads = state.threads.filter((thread) => thread.id !== threadId);
      if (state.selectedThread?.id === threadId) clearSelectedThread();
      renderThreads();
      showToast(uiText("tasks.unarchiveThread.showToast"));
    } catch (error) {
      showToast(error.message);
    }
  }

  return {
    openRenameDialog,
    openThreadActionMenu,
    togglePin,
    renameThread,
    markSelectedThreadsRead,
    archiveSelectedThreads,
    archiveThread,
    unarchiveThread,
  };
}
