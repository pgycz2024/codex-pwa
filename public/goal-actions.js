import { uiText } from "./ui-copy.js";
const GOAL_STATUS_LABELS = {
  active: uiText("goals.labels.active"),
  paused: uiText("goals.labels.paused"),
  blocked: uiText("goals.labels.blocked"),
  usageLimited: uiText("goals.labels.usageLimited"),
  budgetLimited: uiText("goals.labels.budgetLimited"),
  complete: uiText("goals.labels.complete"),
};

export function goalStatusLabel(status) {
  return GOAL_STATUS_LABELS[status] || status || uiText("goals.goalStatusLabel.text");
}

export function formatGoalDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = Math.floor(total % 60);
  if (hours) return uiText("goals.formatGoalDuration.text3", hours, minutes);
  if (minutes) return uiText("goals.formatGoalDuration.text2", minutes, remaining);
  return uiText("goals.formatGoalDuration.text", remaining);
}

export function formatGoalTokens(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

export function createGoalActionsManager({
  state,
  elements,
  api,
  el,
  closeAllMenus,
  requestConfirmation,
  confirmationPreview,
  showLoadingToast,
  finishLoadingToast,
  showToast,
  updateChatActions,
  renderInfoPanel,
} = {}) {
  function renderGoalBar() {
    const bar = elements.goalBar;
    bar.replaceChildren();
    const goal = state.goal;
    if (!state.selectedThread || state.goalSupported === false || !goal) {
      bar.classList.add("hidden");
      return;
    }
    bar.classList.remove("hidden");
    const mark = el("span", "goal-mark", "◎");
    const copy = el("div", "goal-copy");
    const heading = el("div", "goal-heading");
    heading.append(
      el("strong", "", "Goal"),
      el("span", `goal-status ${goal.status || ""}`, goalStatusLabel(goal.status)),
    );
    const objective = el("span", "goal-objective", goal.objective || uiText("goals.renderGoalBar.el"));
    objective.title = goal.objective || "";
    copy.append(heading, objective);
    if (goal.tokenBudget) {
      const progress = el("div", "goal-progress");
      const progressBar = el("div", "goal-progress-bar");
      progressBar.style.width = `${Math.min(100, Math.round((Number(goal.tokensUsed || 0) / Number(goal.tokenBudget)) * 100))}%`;
      progress.append(progressBar);
      copy.append(progress);
    }
    copy.append(el("span", "goal-meta", `${formatGoalTokens(goal.tokensUsed)} tokens${goal.tokenBudget ? ` / ${formatGoalTokens(goal.tokenBudget)}` : ""} · ${formatGoalDuration(goal.timeUsedSeconds)}`));
    const actions = el("div", "goal-actions");
    const pending = state.goalActionPending;
    const status = goal.status;
    const edit = el("button", "", uiText("common.editGoal"));
    edit.type = "button";
    edit.disabled = pending;
    edit.addEventListener("click", () => openGoalDialog({ thread: state.selectedThread, goal }));
    actions.append(edit);
    if (status === "active") {
      const pause = el("button", "", uiText("common.pauseGoal"));
      pause.type = "button";
      pause.disabled = pending;
      pause.addEventListener("click", () => setGoalStatus("paused"));
      actions.append(pause);
    } else if (status && status !== "complete") {
      const resume = el("button", "", uiText("common.resumeGoal"));
      resume.type = "button";
      resume.disabled = pending;
      resume.addEventListener("click", () => setGoalStatus("active"));
      actions.append(resume);
    }
    if (status && status !== "complete") {
      const finish = el("button", "danger", uiText("common.completeGoal"));
      finish.type = "button";
      finish.disabled = pending;
      finish.addEventListener("click", () => setGoalStatus("complete"));
      actions.append(finish);
    }
    const clear = el("button", "danger", uiText("common.clearGoal"));
    clear.type = "button";
    clear.disabled = pending;
    clear.addEventListener("click", clearGoal);
    actions.append(clear);
    bar.append(mark, copy, actions);
  }

  function applyGoalState(threadId, result = {}) {
    if (!threadId || state.selectedThread?.id !== threadId) return;
    state.goalSupported = result.supported !== false;
    state.goal = result.goal || null;
    state.selectedThread.goal = state.goal;
    renderGoalBar();
    updateChatActions();
    renderInfoPanel();
  }

  async function loadThreadGoal(threadId) {
    if (!threadId) return;
    const sequence = ++state.goalLoadSequence;
    state.goalLoading = true;
    renderGoalBar();
    try {
      const result = await api(`/api/threads/${encodeURIComponent(threadId)}/goal`);
      if (sequence !== state.goalLoadSequence || state.selectedThread?.id !== threadId) return;
      applyGoalState(threadId, result);
    } catch (error) {
      if (sequence === state.goalLoadSequence && state.selectedThread?.id === threadId) {
        state.goalSupported = null;
        state.goal = null;
        renderGoalBar();
        console.warn(`Unable to load Goal: ${error.message}`);
      }
    } finally {
      if (sequence === state.goalLoadSequence) state.goalLoading = false;
    }
  }

  async function setGoalStatus(status) {
    const threadId = state.selectedThread?.id;
    if (!threadId || !state.goal || state.goalActionPending) return;
    const goalActions = {
      active: { eyebrow: uiText("common.resumeGoal"), title: uiText("goals.setGoalStatus.title3"), message: uiText("goals.setGoalStatus.message3", state.goal.objective), confirmLabel: uiText("common.resumeGoal") },
      paused: { eyebrow: uiText("common.pauseGoal"), title: uiText("goals.setGoalStatus.title2"), message: uiText("goals.setGoalStatus.message2", state.goal.objective), confirmLabel: uiText("common.pauseGoal") },
      complete: { eyebrow: uiText("common.completeGoal"), title: uiText("goals.setGoalStatus.title"), message: uiText("goals.setGoalStatus.message", state.goal.objective), confirmLabel: uiText("common.completeGoal"), danger: true },
    };
    const action = goalActions[status];
    if (action && !(await requestConfirmation(action))) return;
    state.goalActionPending = true;
    const loadingToken = showLoadingToast(uiText("goals.setGoalStatus.showLoadingToast"));
    renderGoalBar();
    try {
      const result = await api(`/api/threads/${encodeURIComponent(threadId)}/goal`, { method: "POST", body: JSON.stringify({ status }) });
      applyGoalState(threadId, result);
      showToast(status === "active" ? uiText("goals.setGoalStatus.showToast4") : status === "paused" ? uiText("goals.setGoalStatus.showToast3") : uiText("goals.setGoalStatus.showToast2"));
    } catch (error) {
      showToast(uiText("goals.setGoalStatus.showToast", error.message), 5200);
    } finally {
      finishLoadingToast(loadingToken);
      state.goalActionPending = false;
      renderGoalBar();
    }
  }

  async function clearGoal() {
    const threadId = state.selectedThread?.id;
    if (!threadId || !state.goal || state.goalActionPending) return;
    const confirmed = await requestConfirmation({
      eyebrow: uiText("common.clearGoal"), title: uiText("goals.clearGoal.title"),
      message: uiText("goals.clearGoal.message", state.goal.objective),
      confirmLabel: uiText("common.clearGoal"), danger: true,
    });
    if (!confirmed) return;
    state.goalActionPending = true;
    const loadingToken = showLoadingToast(uiText("goals.clearGoal.showLoadingToast"));
    renderGoalBar();
    try {
      const result = await api(`/api/threads/${encodeURIComponent(threadId)}/goal`, { method: "DELETE", body: "{}" });
      applyGoalState(threadId, result);
      showToast(uiText("goals.clearGoal.showToast2"));
    } catch (error) {
      showToast(uiText("goals.clearGoal.showToast", error.message), 5200);
    } finally {
      finishLoadingToast(loadingToken);
      state.goalActionPending = false;
      renderGoalBar();
    }
  }

  function openGoalDialog({ thread = state.selectedThread, goal = state.goal } = {}) {
    if (!thread || state.goalSupported === false) return;
    closeAllMenus();
    state.goalEditThreadId = thread.id;
    elements.goalDialogTitle.textContent = goal ? uiText("common.editGoal") : uiText("common.createGoal");
    elements.goalObjectiveInput.value = goal?.objective || "";
    elements.goalBudgetInput.value = goal?.tokenBudget == null ? "" : String(goal.tokenBudget);
    elements.goalStatusInput.value = goal?.status || "active";
    elements.goalDialogHint.textContent = goal ? uiText("goals.openGoalDialog.textContent2") : uiText("goals.openGoalDialog.textContent");
    elements.goalDialog.showModal();
    setTimeout(() => elements.goalObjectiveInput.focus(), 40);
  }

  async function saveGoal(event) {
    event.preventDefault();
    const threadId = state.goalEditThreadId || state.selectedThread?.id;
    if (!threadId) return;
    const objective = elements.goalObjectiveInput.value.trim();
    if (!objective) { showToast(uiText("goals.saveGoal.showToast4")); elements.goalObjectiveInput.focus(); return; }
    const budgetText = elements.goalBudgetInput.value.trim();
    const tokenBudget = budgetText === "" ? null : Number(budgetText);
    if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0)) { showToast(uiText("common.goalBudgetInvalid")); return; }
    const confirmed = await requestConfirmation({
      eyebrow: state.goal ? uiText("headings.update_goal") : uiText("headings.create_goal"),
      title: state.goal ? uiText("goals.saveGoal.title2") : uiText("goals.saveGoal.title"),
      message: `${confirmationPreview(objective, 1_200)}\n\n${tokenBudget === null ? uiText("goals.saveGoal.message2") : uiText("goals.saveGoal.message", tokenBudget.toLocaleString("zh-CN"))}`,
      confirmLabel: state.goal ? uiText("common.confirmSave") : uiText("common.confirmCreate"),
    });
    if (!confirmed) return;
    const submit = elements.goalForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    const previousSubmitLabel = submit.textContent;
    const loadingToken = showLoadingToast(uiText("goals.saveGoal.showLoadingToast"));
    submit.textContent = uiText("common.saving");
    try {
      const result = await api(`/api/threads/${encodeURIComponent(threadId)}/goal`, { method: "POST", body: JSON.stringify({ objective, tokenBudget, status: elements.goalStatusInput.value }) });
      applyGoalState(threadId, result);
      elements.goalDialog.close();
      showToast(result.goal ? uiText("goals.saveGoal.showToast3") : uiText("goals.saveGoal.showToast2"));
    } catch (error) {
      showToast(uiText("goals.saveGoal.showToast", error.message), 5200);
    } finally {
      finishLoadingToast(loadingToken);
      submit.disabled = false;
      submit.textContent = previousSubmitLabel;
    }
  }

  return { applyGoalState, renderGoalBar, loadThreadGoal, setGoalStatus, clearGoal, openGoalDialog, saveGoal };
}
