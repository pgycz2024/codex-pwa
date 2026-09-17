import { uiText } from "./ui-copy.js";
import { modelDisplayName, resolveModel } from "./model-display.js";

export const EFFORT_LABELS = {
  low: uiText("settings.labels.low"),
  medium: uiText("settings.labels.medium"),
  high: uiText("settings.labels.high"),
  xhigh: uiText("settings.labels.xhigh"),
  max: uiText("settings.labels.max"),
  ultra: uiText("settings.labels.ultra"),
};

export const PERMISSION_LABELS = {
  request: uiText("common.permissionRequest"),
  auto: uiText("common.permissionAuto"),
  full: uiText("common.permissionFull"),
  custom: uiText("common.permissionCustom"),
};

export function effortLabel(value) {
  return EFFORT_LABELS[value] || value || uiText("common.modelDefault");
}

export function createTaskSettingsManager({
  state,
  elements,
  api,
  el,
  renderInfoPanel,
}) {
  function modelFor(value) {
    return resolveModel(value, state.models);
  }

  function ensureModelOption(select, value) {
    const key = String(value || "").trim();
    if (!key || [...select.options].some((option) => option.value === key)) return;
    const option = el("option", "", modelDisplayName(key));
    option.value = key;
    select.append(option);
  }

  function settingsState(threadId = state.selectedThread?.id) {
    if (!threadId) return { effective: {}, pending: {} };
    if (!state.threadSettings.has(threadId)) state.threadSettings.set(threadId, { effective: {}, pending: {} });
    return state.threadSettings.get(threadId);
  }

  function cleanPendingSettings(effective, pending) {
    const cleaned = { ...pending };
    for (const key of ["model", "effort", "permissionPreset"]) {
      if (Object.hasOwn(cleaned, key) && (cleaned[key] ?? null) === (effective[key] ?? null)) delete cleaned[key];
    }
    return cleaned;
  }

  function applyEffectiveSettings(threadId, settings) {
    if (!threadId || !settings) return;
    const current = settingsState(threadId);
    current.effective = { ...settings };
    current.pending = cleanPendingSettings(current.effective, current.pending);
  }

  function commitEffectiveSettings(threadId, settings) {
    if (!threadId || !settings) return;
    state.threadSettings.set(threadId, { effective: { ...settings }, pending: {} });
  }

  function displayedSettings(threadId = state.selectedThread?.id) {
    const current = settingsState(threadId);
    return { ...current.effective, ...current.pending };
  }

  function pendingSettings(threadId = state.selectedThread?.id) {
    return { ...settingsState(threadId).pending };
  }

  function hasPendingSettings(threadId = state.selectedThread?.id) {
    return Object.keys(settingsState(threadId).pending).length > 0;
  }

  function syncEffortOptions(select, modelValue, selectedValue = "") {
    const first = select.options[0];
    select.replaceChildren(first);
    const model = modelFor(modelValue);
    const defaultEffort = model?.defaultReasoningEffort || "";
    first.textContent = defaultEffort ? uiText("settings.syncEffortOptions.textContent", effortLabel(defaultEffort)) : uiText("common.modelDefault");
    const efforts = model?.supportedReasoningEfforts || [];
    for (const effort of efforts) {
      const value = typeof effort === "string" ? effort : effort.reasoningEffort;
      if (!value) continue;
      const option = el("option", "", effortLabel(value));
      option.value = value;
      option.title = typeof effort === "object" ? effort.description || "" : "";
      select.append(option);
    }
    if (selectedValue && ![...select.options].some((option) => option.value === selectedValue)) {
      const option = el("option", "", effortLabel(selectedValue));
      option.value = selectedValue;
      select.append(option);
    }
    select.value = selectedValue;
  }

  function syncSettingsControls() {
    const settings = displayedSettings();
    const effective = settingsState().effective;
    const modelValue = settings.model || effective.model || "";
    if (modelValue && ![...elements.settingsModelSelect.options].some((option) => option.value === modelValue)) {
      ensureModelOption(elements.settingsModelSelect, modelValue);
    }
    elements.settingsModelSelect.value = modelValue;
    syncEffortOptions(elements.settingsEffortSelect, elements.settingsModelSelect.value, settings.effort || "");
    const permission = settings.permissionPreset || effective.permissionPreset || "custom";
    elements.settingsPermissionSelect.querySelector('option[value="custom"]')?.remove();
    if (permission === "custom" && ![...elements.settingsPermissionSelect.options].some((option) => option.value === "custom")) {
      const option = el("option", "", PERMISSION_LABELS.custom);
      option.value = "custom";
      elements.settingsPermissionSelect.prepend(option);
    }
    elements.settingsPermissionSelect.value = permission;
    const pending = hasPendingSettings();
    elements.settingsPendingHint.textContent = pending
      ? uiText("settings.syncSettingsControls.textContent2")
      : uiText("settings.syncSettingsControls.textContent");
  }

  function updateOptionChips() {
    const settings = displayedSettings();
    const model = modelFor(settings.model);
    const pending = hasPendingSettings();
    elements.modelChip.textContent = `${model?.displayName || settings.model || uiText("common.currentModel")}${pending ? uiText("settings.updateOptionChips.textContent") : ""}`;
    elements.effortChip.textContent = settings.effort ? effortLabel(settings.effort) : uiText("common.defaultEffort");
    elements.modelChip.classList.toggle("pending", pending);
    elements.effortChip.classList.toggle("pending", pending);
    renderInfoPanel();
  }

  function populateModels() {
    for (const select of [elements.newModelSelect, elements.settingsModelSelect]) {
      const first = select.options[0];
      select.replaceChildren(first);
      for (const model of state.models) {
        const option = el("option", "", model.displayName || model.model || model.id);
        option.value = model.model || model.id;
        if (model.isDefault) option.textContent += uiText("settings.populateModels.textContent");
        select.append(option);
      }
    }
    ensureModelOption(elements.newModelSelect, state.newTaskModel);
    elements.newModelSelect.value = state.newTaskModel;
    syncEffortOptions(elements.newEffortSelect, state.newTaskModel, state.newTaskEffort);
    if (state.selectedThread) syncSettingsControls();
    updateOptionChips();
  }

  async function loadModels() {
    try {
      const result = await api("/api/models");
      state.models = result.data || [];
      populateModels();
    } catch (error) {
      console.warn("Unable to load model catalog", error);
    }
  }

  return {
    modelFor,
    effortLabel,
    permissionLabels: PERMISSION_LABELS,
    ensureModelOption,
    settingsState,
    cleanPendingSettings,
    applyEffectiveSettings,
    commitEffectiveSettings,
    displayedSettings,
    pendingSettings,
    hasPendingSettings,
    syncEffortOptions,
    syncSettingsControls,
    updateOptionChips,
    populateModels,
    loadModels,
  };
}
