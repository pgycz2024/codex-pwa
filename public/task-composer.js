import { uiText } from "./ui-copy.js";
import { normalizeUserMessageText, createClientMessageId } from "./message-reconcile.js";
import { threadRecencyEpoch } from "./thread-list.js";
import { appendUploadedFileReferences } from "./upload-utils.js";
import { effortLabel, PERMISSION_LABELS as permissionLabels } from "./task-settings.js";

export function createTaskComposer({
  state,
  elements,
  stored,
  api,
  writeRequests,
  storage,
  closeAllMenus,
  syncEffortOptions,
  syncListModeTabs,
  loadThreads,
  openThread,
  showToast,
  requestConfirmation,
  confirmationPreview,
  uploadSelectedFiles,
  clearUploadQueue,
  renderThread,
  updateThreadRoute,
  renderOptimisticUserMessage,
  updateTurnControls,
  returnToLatestConversation,
  clearThreadDraft,
  resizeComposer,
  scrollToBottom,
  hasPendingSettings,
  pendingSettings,
  commitEffectiveSettings,
  assignOptimisticMessageTurn,
  updateChatActions,
  updateOptionChips,
  clearThreadWriteConflict,
  markThreadWriteConflict,
  refreshSelectedThread,
  draftKey,
  saveThreadDraft,
  discardOptimisticMessage
}) {
  function openNewTaskDialog(prompt = "") {
    closeAllMenus();
    elements.cwdInput.value ||= state.selectedThread?.cwd || stored.lastDirectory || state.roots[0] || "";
    if (state.selectedThread?.cwd) elements.cwdInput.value = state.selectedThread.cwd;
    elements.newPromptInput.value = prompt;
    elements.newGoalObjective.value = "";
    elements.newGoalBudget.value = "";
    elements.newGoalDetails.open = false;
    elements.newModelSelect.value = state.newTaskModel;
    syncEffortOptions(elements.newEffortSelect, state.newTaskModel, state.newTaskEffort);
    elements.newPermissionSelect.value = state.newTaskPermission;
    elements.newTaskDialog.showModal();
    setTimeout(() => elements.newPromptInput.focus(), 40);
  }

  async function reconcileUnknownTaskStart({ cwd, prompt, submittedAt, submit }) {
    state.taskStartReconciliation = true;
    submit.disabled = true;
    submit.textContent = uiText("composer.reconcileUnknownTaskStart.textContent");
    try {
      for (const delay of [700, 2_000, 5_000]) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
        state.threadListMode = "recent";
        syncListModeTabs();
        await loadThreads({ silent: true });
        const normalizedPrompt = normalizeUserMessageText(prompt);
        const candidate = state.threads.find((thread) => (
          !thread.archived
          && thread.cwd === cwd
          && threadRecencyEpoch(thread) >= submittedAt - 5
          && (!thread.preview || normalizedPrompt.startsWith(normalizeUserMessageText(thread.preview)))
        ));
        if (!candidate) continue;
        elements.newTaskDialog.close();
        await openThread(candidate.id, { archived: false });
        showToast(uiText("composer.reconcileUnknownTaskStart.showToast3"), 5200);
        return;
      }
      showToast(uiText("composer.reconcileUnknownTaskStart.showToast2"), 9000);
    } catch (error) {
      showToast(uiText("composer.reconcileUnknownTaskStart.showToast", error.message), 9000);
    } finally {
      state.taskStartReconciliation = false;
      submit.disabled = false;
      submit.textContent = uiText("common.startTask");
    }
  }

  async function createTask(event) {
    event.preventDefault();
    if (state.uploadRequest || state.taskStartReconciliation) return;
    const originalPrompt = elements.newPromptInput.value.trim();
    const cwd = elements.cwdInput.value.trim();
    const goalObjective = elements.newGoalObjective.value.trim();
    const goalBudgetText = elements.newGoalBudget.value.trim();
    const goalBudget = goalBudgetText === "" ? null : Number(goalBudgetText);
    if (!originalPrompt || !cwd) return;
    if (goalObjective && (goalBudget !== null && (!Number.isSafeInteger(goalBudget) || goalBudget < 0))) {
      showToast(uiText("composer.createTask.showToast3"));
      return;
    }
    const confirmed = await requestConfirmation({
      eyebrow: uiText("common.startTask"),
      title: uiText("composer.createTask.title"),
      message: uiText("composer.createTask.message", cwd, elements.newModelSelect.value || uiText("common.defaultModel"), effortLabel(elements.newEffortSelect.value), permissionLabels[elements.newPermissionSelect.value] || elements.newPermissionSelect.value, confirmationPreview(originalPrompt, 1_200), goalObjective ? `\n\nGoal：${confirmationPreview(goalObjective, 600)}` : ""),
      confirmLabel: uiText("common.confirmStart"),
    });
    if (!confirmed) return;
    const submit = elements.newTaskForm.querySelector('button[type="submit"]');
    const submittedAt = Date.now() / 1000;
    const clientUserMessageId = state.protocol?.bridgeCapabilities?.clientMessageCorrelation === true ? createClientMessageId() : null;
    submit.disabled = true;
    let prompt = originalPrompt;
    try {
      if (state.newTaskFiles.length) {
        submit.textContent = uiText("common.uploading");
        const uploaded = await uploadSelectedFiles("new", { cwd: elements.cwdInput.value.trim() });
        prompt = appendUploadedFileReferences(originalPrompt, uploaded);
        clearUploadQueue("new");
        elements.newPromptInput.value = prompt;
      }
      submit.textContent = uiText("composer.createTask.textContent");
      const result = await api("/api/threads", {
        method: "POST",
        body: JSON.stringify({
          cwd: elements.cwdInput.value.trim(), prompt, clientUserMessageId,
          model: elements.newModelSelect.value,
          effort: elements.newEffortSelect.value,
          permissionPreset: elements.newPermissionSelect.value,
          ...(goalObjective ? { goal: { objective: goalObjective, tokenBudget: goalBudget, status: "active" } } : {}),
        }),
      });
      state.newTaskModel = elements.newModelSelect.value;
      state.newTaskEffort = elements.newEffortSelect.value;
      state.newTaskPermission = elements.newPermissionSelect.value;
      storage.setItem("codex-pwa-model", state.newTaskModel);
      storage.setItem("codex-pwa-effort", state.newTaskEffort);
      storage.setItem("codex-pwa-permission", state.newTaskPermission);
      storage.setItem("codex-pwa-last-directory", elements.cwdInput.value.trim());
      elements.newTaskDialog.close();
      elements.newPromptInput.value = "";
      elements.newGoalObjective.value = "";
      elements.newGoalBudget.value = "";
      elements.newGoalDetails.open = false;
      clearUploadQueue("new");
      if (state.threadListMode === "archived") state.threadListMode = "recent";
      syncListModeTabs();
      const thread = { ...result.thread, archived: false, turns: [] };
      state.ownedThreads.add(thread.id);
      state.releasingThreads.delete(thread.id);
      state.threads.unshift(thread);
      renderThread(thread, undefined, { settings: result.settings, goal: result.goal || null, goalSupported: result.goalSupported });
      updateThreadRoute(thread.id);
      state.activeTurnId = result.turn?.id || null;
      renderOptimisticUserMessage(prompt, { turnId: state.activeTurnId, clientId: clientUserMessageId });
      updateTurnControls();
      if (result.goalError) showToast(uiText("composer.createTask.showToast2", result.goalError), 5200);
      await loadThreads({ silent: true });
    } catch (error) {
      if (error.outcomeUnknown) {
        showToast(uiText("composer.createTask.showToast"), 9000);
        reconcileUnknownTaskStart({ cwd, prompt, submittedAt, submit });
      } else {
        showToast(error.message, 9000, {
          label: uiText("common.retry"),
          onClick: () => elements.newTaskForm.requestSubmit(),
        });
      }
    } finally {
      if (!state.taskStartReconciliation) {
        submit.disabled = false;
        submit.textContent = uiText("common.startTask");
      }
    }
  }

  async function sendPrompt(event) {
    event.preventDefault();
    if (!state.selectedThread) return openNewTaskDialog(elements.promptInput.value.trim());
    if (state.pendingComposerSends.has(state.selectedThread.id)) return showToast(uiText("composer.sendPrompt.showToast7"));
    if (state.uploadRequest) return;
    const originalPrompt = elements.promptInput.value.trim();
    if (!originalPrompt) return;
    const threadId = state.selectedThread.id;
    const viewingHistory = state.historyContext.active;
    const running = Boolean(state.activeTurnId);
    const attachmentNote = state.pendingFiles.length
      ? uiText("composer.sendPrompt.text2", state.pendingFiles.length)
      : "";
    const confirmed = await requestConfirmation({
      eyebrow: viewingHistory ? uiText("headings.return_to_latest") : running ? uiText("common.steerTask") : uiText("common.sendMessage"),
      title: viewingHistory ? uiText("composer.sendPrompt.title3") : running ? uiText("composer.sendPrompt.title2") : uiText("composer.sendPrompt.title"),
      message: `${confirmationPreview(originalPrompt, 1_200)}\n\n${viewingHistory ? uiText("composer.sendPrompt.message3") : running ? uiText("composer.sendPrompt.message2") : uiText("composer.sendPrompt.message")}${attachmentNote}`,
      confirmLabel: viewingHistory ? uiText("composer.sendPrompt.confirmLabel") : running ? uiText("common.confirmSteer") : uiText("common.confirmSend"),
    });
    if (!confirmed) return;
    if (state.historyContext.active) {
      elements.sendButton.disabled = true;
      const restored = await returnToLatestConversation();
      elements.sendButton.disabled = false;
      if (!restored) {
        showToast(uiText("composer.sendPrompt.showToast6"), 5200);
        return;
      }
    }
    if (state.selectedThread?.id !== threadId) {
      showToast(uiText("composer.sendPrompt.showToast5"), 3600);
      return;
    }
    if (state.pendingComposerSends.has(threadId)) return;
    state.pendingComposerSends.add(threadId);
    let prompt = originalPrompt;
    let rendered = false;
    let optimistic = null;
    elements.sendButton.disabled = true;
    try {
      if (state.pendingFiles.length) {
        const uploaded = await uploadSelectedFiles("composer", { threadId });
        prompt = appendUploadedFileReferences(originalPrompt, uploaded);
        clearUploadQueue("composer");
      }
      if (state.selectedThread?.id !== threadId) throw new Error(uiText("composer.sendPrompt.text"));
      elements.promptInput.value = "";
      clearTimeout(state.draftSaveTimer);
      clearThreadDraft(threadId);
      resizeComposer();
      const existingTurnId = state.activeTurnId;
      optimistic = renderOptimisticUserMessage(prompt, { turnId: existingTurnId });
      rendered = true;
      scrollToBottom(true);
      if (existingTurnId) {
        await writeRequests.request(threadId, `/api/threads/${encodeURIComponent(threadId)}/steer`, {
          method: "POST", body: JSON.stringify({ prompt, turnId: existingTurnId, clientUserMessageId: optimistic?.clientId }),
        }, uiText("common.steerTask"));
        if (hasPendingSettings(threadId)) showToast(uiText("composer.sendPrompt.showToast4"));
      } else {
        const result = await writeRequests.request(threadId, `/api/threads/${encodeURIComponent(threadId)}/turns`, {
          method: "POST", body: JSON.stringify({ prompt, settings: pendingSettings(threadId), clientUserMessageId: optimistic?.clientId }),
        }, uiText("common.sendMessage"));
        commitEffectiveSettings(threadId, result.settings);
        state.ownedThreads.add(threadId);
        state.releasingThreads.delete(threadId);
        if (state.selectedThread?.id === threadId) {
          state.activeTurnId = result.turn?.id || null;
          assignOptimisticMessageTurn(optimistic?.id, state.activeTurnId);
          updateChatActions();
          updateTurnControls();
          updateOptionChips();
        }
      }
      clearThreadWriteConflict(threadId);
    } catch (error) {
      const writeConflict = markThreadWriteConflict(threadId, error);
      if (writeConflict && state.selectedThread?.id === threadId) {
        refreshSelectedThread({ preserveScroll: true }).catch(() => {});
      }
      if (error.outcomeUnknown && rendered) {
        optimistic?.element?.classList.add("outcome-unknown");
        if (optimistic?.element) optimistic.element.dataset.outcomeUnknown = "true";
        optimistic?.element?.setAttribute("title", uiText("composer.sendPrompt.setAttribute"));
        showToast(uiText("composer.sendPrompt.showToast3"), 9000);
        setTimeout(() => {
          if (state.selectedThread?.id === threadId) refreshSelectedThread({ preserveScroll: true }).catch(() => {});
        }, 1_200);
      } else {
        const restoredPrompt = rendered ? prompt : originalPrompt;
        if (state.selectedThread?.id === threadId) clearTimeout(state.draftSaveTimer);
        const current = state.selectedThread?.id === threadId
          ? elements.promptInput.value.trim() : storage.getItem(draftKey(threadId)) || "";
        const draft = current && current !== restoredPrompt ? `${restoredPrompt}\n\n${current}` : restoredPrompt;
        saveThreadDraft(threadId, draft);
        if (state.selectedThread?.id === threadId) {
          elements.promptInput.value = draft;
          resizeComposer();
        }
      }
      if (error.details?.code === "THREAD_WRITE_CANCELLED") {
        if (rendered) discardOptimisticMessage(optimistic?.id);
        showToast(uiText("composer.sendPrompt.showToast2"), 5000);
      } else if (rendered && !error.outcomeUnknown) {
        discardOptimisticMessage(optimistic?.id);
        showToast(uiText("composer.sendPrompt.showToast", error.message), 9000, {
          label: writeConflict ? uiText("composer.sendPrompt.label") : uiText("common.retry"),
          onClick: async () => {
            if (writeConflict) await refreshSelectedThread({ preserveScroll: true }).catch(() => {});
            if (state.selectedThread?.id === threadId) elements.composer.requestSubmit();
          },
        });
      } else if (!error.outcomeUnknown) {
        showToast(error.message, 9000, {
          label: writeConflict ? uiText("composer.sendPrompt.label") : uiText("common.retry"),
          onClick: async () => {
            if (writeConflict) await refreshSelectedThread({ preserveScroll: true }).catch(() => {});
            if (state.selectedThread?.id === threadId) elements.composer.requestSubmit();
          },
        });
      }
    } finally {
      state.pendingComposerSends.delete(threadId);
      updateTurnControls();
    }
  }

  async function stopTurn() {
    const threadId = state.selectedThread?.id;
    const turnId = state.activeTurnId;
    if (!threadId || !turnId) return;
    const confirmed = await requestConfirmation({
      eyebrow: uiText("common.stopTask"),
      title: uiText("composer.stopTurn.title"),
      message: uiText("composer.stopTurn.message"),
      confirmLabel: uiText("common.confirmStop"),
      danger: true,
    });
    if (!confirmed) return;
    if (state.selectedThread?.id !== threadId || state.activeTurnId !== turnId) {
      updateTurnControls();
      showToast(uiText("composer.stopTurn.showToast"), 3600);
      return;
    }
    elements.stopButton.disabled = true;
    try {
      await writeRequests.request(threadId, `/api/threads/${encodeURIComponent(threadId)}/interrupt`, {
        method: "POST", body: JSON.stringify({ turnId }),
      }, uiText("common.stopTask"));
    } catch (error) {
      if (markThreadWriteConflict(threadId, error)) refreshSelectedThread({ preserveScroll: true }).catch(() => {});
      showToast(error.message);
    } finally {
      elements.stopButton.disabled = false;
      updateTurnControls();
    }
  }

  return { openNewTaskDialog, createTask, sendPrompt, stopTurn };
}
