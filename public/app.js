import { normalizeUserMessageText, reconcilePendingUserMessage } from "./message-reconcile.js";
import { createMathExtensions } from "./markdown-math.js";
import { filePreviewHref, fileRawHref, normalizeMarkdownFileLinks, serverFilePath } from "./file-links.js";
import { appendUploadedFileReferences, formatUploadSize } from "./upload-utils.js";
import { readStoredStringArray } from "./storage-utils.js";
import { boundedWindow, fixedVirtualRange } from "./virtual-list.js";
import { modelDisplayName, resolveModel } from "./model-display.js";
import {
  DIFF_CHUNK_SIZE,
  chronologicalTurns,
  countDiffLines,
  nextDiffChunkEnd,
} from "./history-utils.js";
import { Marked } from "/vendor/marked/marked.esm.js";
import DOMPurify from "/vendor/dompurify/purify.es.mjs";
import katex from "/vendor/katex/katex.mjs";

const stored = {
  theme: localStorage.getItem("codex-pwa-theme") || "dark",
  model: localStorage.getItem("codex-pwa-model") || "",
  effort: localStorage.getItem("codex-pwa-effort") || "",
  permission: localStorage.getItem("codex-pwa-permission") || "request",
  legacyPins: readStoredStringArray(localStorage, "codex-pwa-pins"),
  lastDirectory: localStorage.getItem("codex-pwa-last-directory") || "",
};

const state = {
  roots: [],
  appRoot: "",
  version: "",
  threads: [],
  models: [],
  selectedThread: null,
  activeTurnId: null,
  approvals: new Map(),
  approvalRevision: 0,
  statusLoadSequence: 0,
  itemNodes: new Map(),
  itemTurns: new Map(),
  itemText: new Map(),
  pendingUserMessages: [],
  fileChanges: new Map(),
  rawDiff: "",
  plan: null,
  goal: null,
  goalSupported: null,
  goalLoading: false,
  goalActionPending: false,
  goalLoadSequence: 0,
  goalEditThreadId: null,
  tokenUsage: null,
  threadListMode: "recent",
  query: "",
  pinned: new Set(),
  legacyPins: new Set(stored.legacyPins),
  pinMigrations: new Set(),
  newTaskModel: stored.model,
  newTaskEffort: stored.effort,
  newTaskPermission: stored.permission,
  threadSettings: new Map(),
  transcriptSignatures: new Map(),
  transcriptLoads: new Map(),
  artifacts: new Map(),
  artifactLoadSequence: 0,
  visibleRecoveryPromise: null,
  auth: { authenticated: false, authEnabled: true, csrfToken: null },
  appStarted: false,
  renameTargetId: null,
  eventSource: null,
  eventGeneration: 0,
  eventReconnectTimer: null,
  eventReconnectAttempt: 0,
  offlineSince: null,
  threadLoadSequence: 0,
  threadCursor: null,
  threadsLoadingMore: false,
  threadRenderPending: false,
  openThreadSequence: 0,
  threadRefreshTimer: null,
  historyCursor: null,
  historyLoading: false,
  activityDetailsLoaded: false,
  activityDetailsLoading: false,
  historyComplete: false,
  historyCompleteLoading: false,
  historyCompleteCursor: null,
  historyCompleteStarted: false,
  historyMemoryLimited: false,
  historyRetainedChars: 0,
  historyTurnChars: new Map(),
  historyWindow: {
    enabled: false,
    start: 0,
    end: 0,
    size: 160,
  },
  historyContext: {
    active: false,
    threadId: null,
    targetTurnId: null,
    olderCursor: null,
    newerCursor: null,
    loadingDirection: null,
    deferredUpdates: false,
    sequence: 0,
  },
  historyNodes: {
    threadId: null,
    data: [],
    nextCursor: null,
    error: "",
    loading: false,
    loadingAll: false,
    complete: false,
    memoryLimited: false,
    renderFrame: 0,
    rangeStart: -1,
    rangeEnd: -1,
  },
  loadedTurnIds: new Set(),
  ownedThreads: new Set(),
  releasingThreads: new Set(),
  pendingFiles: [],
  newTaskFiles: [],
  pendingFilesThreadId: null,
  uploadRequest: null,
  uploadContext: null,
  uploadProgress: { loaded: 0, total: 0 },
  uploadPreviewUrls: new Map(),
  streamRenderTimers: new Map(),
  streamFollowItems: new Set(),
  commandRenderTimers: new Map(),
  draftSaveTimer: null,
  viewport: {
    height: 0,
    offsetTop: 0,
    syncTimers: [],
  },
  updateReloading: false,
  updateRequested: false,
  attachmentSourceContext: "composer",
  directorySelectionResolver: null,
  directory: {
    path: "",
    parent: null,
    roots: [],
    breadcrumbs: [],
    entries: [],
    truncated: false,
    loadSequence: 0,
    loading: false,
  },
  fileBrowser: {
    path: localStorage.getItem("codex-pwa-file-browser-path") || "",
    parent: null,
    roots: [],
    entries: [],
    truncated: false,
    loadSequence: 0,
    loading: false,
  },
  devices: [],
  deviceRenameTargetId: null,
  taskStartReconciliation: false,
  threadActionTargetId: null,
  threadActionTargetArchived: false,
  floatingMenu: null,
  confirmResolver: null,
  loadingToastToken: 0,
};

const elementIds = [
  "appShell", "authGate", "loginForm", "loginUsername", "loginPassword", "rememberDevice",
  "loginError", "loginButton", "changeCredentialsLoginButton", "logoutButton", "logoutAllButton", "refreshWebUiButton", "serverFilesButton", "trustedDevicesButton",
  "instanceName", "networkLabel",
  "sidebar", "sidebarBackdrop", "closeSidebarButton", "menuButton", "newTaskButton",
  "emptyNewTaskButton", "threadSearch", "clearSearchButton", "recentTab", "allHistoryTab",
  "archivedTab", "refreshButton", "threadList", "loadMoreThreadsButton", "themeButton", "themeIcon", "themeLabel", "helpButton",
  "connectionDot", "connectionLabel", "chatTitle", "chatMeta", "stopButton", "contextButton",
  "changeCountBadge", "chatMenu", "renameThreadButton", "pinThreadButton", "archiveThreadButton",
  "releaseThreadButton", "goalThreadButton", "copyThreadIdButton", "emptyState", "chatView", "approvalArea", "goalBar", "messages",
  "historyControls", "loadMoreHistoryButton", "loadCompleteHistoryButton", "historyNodesButton", "scrollBottomButton",
  "composer", "promptInput", "sendButton", "attachButton", "fileInput", "photoInput", "attachmentTray",
  "modelChip", "effortChip", "composerHint", "contextPanel",
  "changesTab", "infoTab", "closeContextButton", "changesPanel", "infoPanel", "newTaskDialog",
  "newTaskForm", "closeDialogButton", "cwdInput", "newPromptInput", "newAttachButton", "newFileInput",
  "newPhotoInput", "attachmentSourceDialog", "closeAttachmentSourceButton", "choosePhotoButton",
  "chooseFileButton",
  "newAttachmentTray", "newModelSelect", "browseDirectoryButton", "directoryDialog",
  "closeDirectoryButton", "directoryDialogTitle", "directoryRoots", "directoryBreadcrumbs", "directorySearch",
  "showHiddenDirectories", "directoryCurrentPath", "directoryList", "directoryLimitNotice",
  "newDirectoryForm", "newDirectoryInput", "cancelNewDirectoryButton", "showNewDirectoryButton",
  "chooseDirectoryButton",
  "fileBrowserDialog", "closeFileBrowserButton", "fileBrowserRoots",
  "fileBrowserSearch", "showHiddenFiles", "fileBrowserCurrentPath", "fileBrowserList",
  "fileBrowserLimitNotice", "fileBrowserUploadInput", "uploadToDirectoryButton", "newFileBrowserFolderButton",
  "refreshFileBrowserButton", "newTaskFromDirectoryButton",
  "devicesDialog", "closeDevicesButton", "devicesList", "refreshDevicesButton", "logoutOtherDevicesButton", "changeCredentialsButton",
  "credentialsDialog", "credentialsForm", "closeCredentialsButton", "currentUsernameInput", "currentPasswordInput", "newUsernameInput", "newPasswordInput", "confirmNewPasswordInput", "credentialsError", "saveCredentialsButton",
  "threadActionDialog", "threadActionTitle", "closeThreadActionButton", "actionPinThreadButton",
  "actionRenameThreadButton", "actionCopyThreadIdButton", "actionArchiveThreadButton", "confirmDialog",
  "confirmEyebrow", "confirmTitle", "confirmMessage", "closeConfirmButton", "cancelConfirmButton",
  "submitConfirmButton", "helpDialog", "closeHelpButton", "helpQuestionInput", "askWebUiButton",
  "requestUiChangeButton", "deviceRenameDialog", "deviceRenameForm",
  "closeDeviceRenameButton", "deviceRenameInput",
  "newEffortSelect", "newPermissionSelect", "renameDialog", "renameForm",
  "closeRenameButton", "renameInput", "settingsDialog", "settingsForm", "closeSettingsButton",
  "settingsModelSelect", "settingsEffortSelect", "settingsPermissionSelect", "settingsPendingHint", "goalDialog", "goalForm",
  "goalDialogTitle", "goalObjectiveInput", "goalBudgetInput", "goalStatusInput", "goalDialogHint", "closeGoalButton",
  "newGoalDetails", "newGoalObjective", "newGoalBudget", "historyNodesDialog", "closeHistoryNodesButton",
  "historyNodesSearch", "historyNodesStatus", "historyNodesLoading", "historyNodesList", "historyNodesCanvas", "historyNodesRows",
  "historyNodesLoadMoreButton", "historyNodesLoadAllButton",
  "offlineBanner", "toast",
];
const elements = Object.fromEntries(elementIds.map((id) => [id, document.getElementById(id)]));

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {}),
  };
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && state.auth.csrfToken && !path.startsWith("/api/auth/login")) {
    headers["X-Codex-PWA-CSRF"] = state.auth.csrfToken;
  }
  let response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers,
    });
  } catch (error) {
    error.isNetworkFailure = true;
    if (state.auth.authenticated && !path.startsWith("/api/auth/")) setConnection("offline", error.message);
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) showLogin(payload.error);
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.statusCode = response.status;
    error.details = payload.details || null;
    error.outcomeUnknown = Boolean(payload.details?.outcomeUnknown);
    throw error;
  }
  return payload;
}

function showLogin(message = "") {
  state.auth = { authenticated: false, authEnabled: true, csrfToken: null };
  stopEventConnection();
  elements.appShell.classList.add("hidden");
  elements.authGate.classList.remove("hidden");
  elements.loginError.textContent = message || "";
  elements.loginError.classList.toggle("hidden", !message);
  elements.loginError.classList.toggle("notice", /^已/.test(message));
  setTimeout(() => elements.loginPassword.focus(), 40);
}

function showApplication(session) {
  state.auth = { ...state.auth, ...session, authenticated: true };
  elements.authGate.classList.add("hidden");
  elements.appShell.classList.remove("hidden");
  elements.loginPassword.value = "";
  elements.loginError.classList.add("hidden");
}

function stopEventConnection() {
  state.eventGeneration += 1;
  clearTimeout(state.eventReconnectTimer);
  state.eventReconnectTimer = null;
  state.eventReconnectAttempt = 0;
  state.eventSource?.close();
  state.eventSource = null;
}

function scheduleEventReconnect(generation = state.eventGeneration, { immediate = false } = {}) {
  if (generation !== state.eventGeneration || !state.auth.authenticated) return;
  clearTimeout(state.eventReconnectTimer);
  const attempt = immediate ? 0 : state.eventReconnectAttempt;
  const delay = immediate ? 0 : Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)));
  state.eventReconnectTimer = setTimeout(() => {
    state.eventReconnectTimer = null;
    if (generation !== state.eventGeneration || !state.auth.authenticated) return;
    connectEvents({ generation });
  }, delay);
}

function debounce(fn, delay = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const MAX_UPLOAD_FILES = 20;
const MAX_UPLOAD_FILE_SIZE = 256 * 1024 * 1024;
const MAX_UPLOAD_BATCH_SIZE = 512 * 1024 * 1024;
const STREAM_RENDER_INTERVAL_MS = 90;
const COMMAND_OUTPUT_PREVIEW_CHARS = 12_000;
const TOOL_OUTPUT_PREVIEW_CHARS = 8_000;
const MAX_LIVE_TEXT_CHARS = 512 * 1024;
const MAX_LIVE_COMMAND_CHARS = 768 * 1024;
const MAX_RETAINED_HISTORY_TURNS = 2_500;
const MAX_RETAINED_HISTORY_CHARS = 32 * 1024 * 1024;
const MAX_RETAINED_HISTORY_NODES = 5_000;
const MAX_HISTORY_NODE_TEXT_CHARS = 16_000;
const HISTORY_CONTEXT_PAGE_SIZE = 20;
const LIVE_TEXT_TRUNCATION_MARKER = "\n\n… 较早的实时内容已从手机内存中释放；任务完成后可重新加载历史记录。 …\n\n";

function uploadQueue(context) {
  return context === "new" ? state.newTaskFiles : state.pendingFiles;
}

function uploadTray(context) {
  return context === "new" ? elements.newAttachmentTray : elements.attachmentTray;
}

function renderUploadQueue(context) {
  const files = uploadQueue(context);
  const tray = uploadTray(context);
  const uploading = state.uploadRequest && state.uploadContext === context;
  tray.replaceChildren();

  files.forEach((file, index) => {
    const chip = el("div", "attachment-chip");
    if (file.type?.startsWith("image/")) {
      chip.classList.add("with-thumbnail");
      let previewUrl = state.uploadPreviewUrls.get(file);
      if (!previewUrl) {
        previewUrl = URL.createObjectURL(file);
        state.uploadPreviewUrls.set(file, previewUrl);
      }
      const preview = el("img", "attachment-thumbnail");
      preview.src = previewUrl;
      preview.alt = "";
      chip.append(preview);
    }
    const name = el("span", "attachment-name", file.name);
    name.title = file.name;
    const size = el("span", "attachment-size", formatUploadSize(file.size));
    const remove = el("button", "attachment-remove", "×");
    remove.type = "button";
    remove.disabled = Boolean(uploading);
    remove.setAttribute("aria-label", `移除 ${file.name}`);
    remove.addEventListener("click", () => {
      const previewUrl = state.uploadPreviewUrls.get(file);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      state.uploadPreviewUrls.delete(file);
      files.splice(index, 1);
      if (context === "composer" && files.length === 0) state.pendingFilesThreadId = null;
      renderUploadQueue(context);
    });
    chip.append(name, size, remove);
    tray.append(chip);
  });

  if (uploading) {
    const progress = el("div", "upload-progress");
    const copy = el("div", "upload-progress-copy");
    const { loaded, total } = state.uploadProgress;
    const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    copy.append(
      el("span", "", `正在上传 ${files.length} 个文件…`),
      el("span", "", total > 0 ? `${percent}%` : formatUploadSize(loaded)),
    );
    const cancel = el("button", "upload-cancel", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", () => state.uploadRequest?.abort());
    const track = el("div", "upload-progress-track");
    const bar = el("div", "upload-progress-bar");
    bar.style.width = `${percent}%`;
    track.append(bar);
    progress.append(copy, cancel, track);
    tray.append(progress);
  }

  tray.classList.toggle("hidden", files.length === 0 && !uploading);
}

function clearUploadQueue(context) {
  for (const file of uploadQueue(context)) {
    const previewUrl = state.uploadPreviewUrls.get(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    state.uploadPreviewUrls.delete(file);
  }
  uploadQueue(context).length = 0;
  if (context === "new") {
    elements.newFileInput.value = "";
    elements.newPhotoInput.value = "";
  }
  else {
    elements.fileInput.value = "";
    elements.photoInput.value = "";
    state.pendingFilesThreadId = null;
  }
  renderUploadQueue(context);
}

function queueSelectedFiles(context, selectedFiles) {
  const queue = uploadQueue(context);
  if (context === "composer" && queue.length === 0) {
    state.pendingFilesThreadId = state.selectedThread?.id || null;
  }
  let totalSize = queue.reduce((sum, file) => sum + file.size, 0);
  let rejected = "";
  for (const file of selectedFiles) {
    if (queue.length >= MAX_UPLOAD_FILES) {
      rejected = "一次最多上传 20 个文件";
      break;
    }
    if (file.size > MAX_UPLOAD_FILE_SIZE) {
      rejected = `${file.name} 超过 256 MB`;
      continue;
    }
    if (totalSize + file.size > MAX_UPLOAD_BATCH_SIZE) {
      rejected = "单批文件总大小不能超过 512 MB";
      break;
    }
    const duplicate = queue.some((queued) => (
      queued.name === file.name && queued.size === file.size && queued.lastModified === file.lastModified
    ));
    if (duplicate) continue;
    queue.push(file);
    totalSize += file.size;
  }
  renderUploadQueue(context);
  if (rejected) showToast(rejected, 5200);
}

function openAttachmentSource(context) {
  if (state.uploadRequest) return;
  closeAllMenus();
  state.attachmentSourceContext = context;
  if (!elements.attachmentSourceDialog.open) elements.attachmentSourceDialog.showModal();
}

function chooseAttachmentSource(kind) {
  const context = state.attachmentSourceContext;
  const input = context === "new"
    ? kind === "photo" ? elements.newPhotoInput : elements.newFileInput
    : kind === "photo" ? elements.photoInput : elements.fileInput;
  elements.attachmentSourceDialog.close();
  input.click();
}

function uploadSelectedFiles(context, target) {
  const files = [...uploadQueue(context)];
  if (files.length === 0) return Promise.resolve([]);
  if (state.uploadRequest) return Promise.reject(new Error("已有文件正在上传"));

  const params = new URLSearchParams(target);
  const form = new FormData();
  files.forEach((file) => form.append("files", file, file.name));
  const request = new XMLHttpRequest();
  state.uploadRequest = request;
  state.uploadContext = context;
  state.uploadProgress = { loaded: 0, total: files.reduce((sum, file) => sum + file.size, 0) };
  elements.attachButton.disabled = true;
  elements.newAttachButton.disabled = true;
  renderUploadQueue(context);

  return new Promise((resolve, reject) => {
    function cleanup() {
      if (state.uploadRequest === request) {
        state.uploadRequest = null;
        state.uploadContext = null;
        state.uploadProgress = { loaded: 0, total: 0 };
      }
      elements.attachButton.disabled = false;
      elements.newAttachButton.disabled = false;
      renderUploadQueue(context);
    }

    request.open("POST", `/api/files/upload?${params}`);
    request.setRequestHeader("X-Codex-PWA-Upload", "1");
    if (state.auth.csrfToken) request.setRequestHeader("X-Codex-PWA-CSRF", state.auth.csrfToken);
    request.upload.addEventListener("progress", (event) => {
      state.uploadProgress = { loaded: event.loaded, total: event.lengthComputable ? event.total : 0 };
      renderUploadQueue(context);
    });
    request.addEventListener("load", () => {
      let payload = {};
      try { payload = JSON.parse(request.responseText || "{}"); } catch {}
      cleanup();
      if (request.status >= 200 && request.status < 300) resolve(payload.files || []);
      else reject(new Error(payload.error || `上传失败（HTTP ${request.status}）`));
    });
    request.addEventListener("error", () => { cleanup(); reject(new Error("上传连接中断")); });
    request.addEventListener("abort", () => { cleanup(); reject(new Error("上传已取消")); });
    request.send(form);
  });
}

function showToast(message, duration = 3600, action = null) {
  state.loadingToastToken = 0;
  elements.toast.classList.remove("loading");
  elements.toast.replaceChildren(el("span", "toast-message", message));
  if (action?.label && typeof action.onClick === "function") {
    const button = el("button", "toast-action", action.label);
    button.type = "button";
    button.addEventListener("click", action.onClick, { once: true });
    elements.toast.append(button);
  }
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  if (duration > 0) showToast.timer = setTimeout(() => elements.toast.classList.add("hidden"), duration);
}

function dismissToast() {
  state.loadingToastToken = 0;
  elements.toast.classList.remove("loading");
  clearTimeout(showToast.timer);
  showToast.timer = null;
  elements.toast.classList.add("hidden");
  elements.toast.replaceChildren();
}

function showLoadingToast(message = "正在加载中……") {
  const token = Number(state.loadingToastToken || 0) + 1;
  showToast(message, 0);
  state.loadingToastToken = token;
  elements.toast.classList.add("loading");
  return token;
}

function finishLoadingToast(token) {
  if (state.loadingToastToken !== token) return;
  state.loadingToastToken = 0;
  elements.toast.classList.remove("loading");
  dismissToast();
}

function showHistoryContextFeedback(message, duration = 2600) {
  dismissToast();
  const banner = elements.messages.querySelector(".history-context-banner");
  if (!banner) {
    showToast(message, duration);
    return;
  }
  clearTimeout(showHistoryContextFeedback.timer);
  elements.messages.querySelector(".history-context-feedback")?.remove();
  const feedback = el("div", "history-context-feedback", message);
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  banner.insertAdjacentElement("afterend", feedback);
  if (duration > 0) {
    showHistoryContextFeedback.timer = setTimeout(() => {
      if (feedback.isConnected) feedback.remove();
    }, duration);
  }
}

async function copyText(value) {
  const text = String(value || "");
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const input = el("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch {}
  input.remove();
  return copied;
}

function finishConfirmation(value) {
  const resolver = state.confirmResolver;
  state.confirmResolver = null;
  if (elements.confirmDialog.open) elements.confirmDialog.close();
  resolver?.(Boolean(value));
}

function requestConfirmation({ title, message, confirmLabel = "确认", danger = false, eyebrow = "确认操作" }) {
  closeAllMenus();
  if (state.confirmResolver) finishConfirmation(false);
  elements.confirmEyebrow.textContent = eyebrow;
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.submitConfirmButton.textContent = confirmLabel;
  elements.submitConfirmButton.className = danger ? "danger-button" : "primary-button";
  elements.confirmDialog.showModal();
  return new Promise((resolve) => { state.confirmResolver = resolve; });
}

function confirmationPreview(value, limit = 900) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 20))}\n… 已折叠 ${text.length - limit} 个字符 …`;
}

async function copyThreadId(threadId = state.selectedThread?.id) {
  if (!threadId) return;
  const copied = await copyText(threadId);
  showToast(copied ? "任务 ID 已复制" : "复制任务 ID 失败，请长按文本复制", copied ? 2600 : 5200);
}

function draftKey(threadId) {
  return `codex-pwa-draft:${threadId}`;
}

function saveThreadDraft(threadId, value = elements.promptInput.value) {
  if (!threadId) return;
  const text = String(value || "");
  if (text) localStorage.setItem(draftKey(threadId), text);
  else localStorage.removeItem(draftKey(threadId));
}

function clearThreadDraft(threadId) {
  if (threadId) localStorage.removeItem(draftKey(threadId));
}

function restoreThreadDraft(threadId) {
  elements.promptInput.value = threadId ? localStorage.getItem(draftKey(threadId)) || "" : "";
  resizeComposer();
}

function scheduleDraftSave() {
  clearTimeout(state.draftSaveTimer);
  const threadId = state.selectedThread?.id;
  state.draftSaveTimer = setTimeout(() => saveThreadDraft(threadId), 220);
}

function routeThreadId() {
  return new URLSearchParams(window.location.search).get("thread") || "";
}

function routeThreadArchived() {
  return new URLSearchParams(window.location.search).get("archived") === "1";
}

function updateThreadRoute(threadId, { replace = false, archived = Boolean(state.selectedThread?.archived) } = {}) {
  const url = new URL(window.location.href);
  if (threadId) {
    url.searchParams.set("thread", threadId);
    if (archived) url.searchParams.set("archived", "1");
    else url.searchParams.delete("archived");
  } else {
    url.searchParams.delete("thread");
    url.searchParams.delete("archived");
  }
  const current = routeThreadId();
  if (current === (threadId || "") && routeThreadArchived() === Boolean(threadId && archived)) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({ threadId: threadId || null }, "", `${url.pathname}${url.search}${url.hash}`);
}

function clearStreamingRenderTimers() {
  for (const timer of state.streamRenderTimers.values()) clearTimeout(timer);
  for (const timer of state.commandRenderTimers.values()) clearTimeout(timer);
  state.streamRenderTimers.clear();
  state.streamFollowItems.clear();
  state.commandRenderTimers.clear();
}

function formatAbsolute(epochSeconds) {
  if (!epochSeconds) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

function formatRelative(epochSeconds) {
  if (!epochSeconds) return "";
  const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (seconds < 50) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(epochSeconds * 1000));
}

function basename(path) {
  const value = String(path || "").replace(/\/+$/, "");
  return value.split("/").pop() || value || "服务器";
}

function threadTitle(thread) {
  return thread?.name || thread?.preview?.split("\n").find(Boolean)?.slice(0, 90) || "未命名任务";
}

function threadPreview(thread) {
  const preview = String(thread?.preview || "").replace(/\s+/g, " ").trim();
  if (!preview || preview === threadTitle(thread)) return basename(thread?.cwd);
  return preview;
}

function statusInfo(status) {
  if (!status) return { type: "idle", label: "空闲" };
  if (typeof status === "string") {
    if (/progress|active|running/i.test(status)) return { type: "active", label: "运行中" };
    if (/error|failed/i.test(status)) return { type: "error", label: "异常" };
    return { type: "idle", label: "空闲" };
  }
  if (status.type === "active") {
    const flags = status.activeFlags || [];
    if (flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")) {
      return { type: "waiting", label: "等待操作" };
    }
    return { type: "active", label: "运行中" };
  }
  if (status.type === "systemError") return { type: "error", label: "异常" };
  return { type: "idle", label: status.type === "notLoaded" ? "已保存" : "空闲" };
}

function sourceLabel(threadOrSource) {
  const thread = threadOrSource?.id || threadOrSource?.clientOrigin ? threadOrSource : null;
  const source = thread ? thread.source : threadOrSource;
  if (thread?.clientOrigin) {
    return ({
      windows: "Windows 客户端",
      "mobile-web": "手机 Web",
      cli: "CLI",
      exec: "Exec / 自动任务",
      subagent: "子代理",
      "app-server": "App Server",
      "local-client": "本地客户端",
      unknown: "未知来源",
    })[thread.clientOrigin] || thread.clientOrigin;
  }
  if (typeof source === "string") return ({ appServer: "PWA", cli: "CLI", vscode: "本地客户端", exec: "Exec" })[source] || source;
  if (source?.custom) return source.custom;
  if (source?.subAgent) return "子代理";
  return "Codex";
}

function applyTheme(theme) {
  const normalized = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = normalized;
  localStorage.setItem("codex-pwa-theme", normalized);
  elements.themeIcon.textContent = normalized === "dark" ? "☾" : "☀";
  elements.themeLabel.textContent = "深/浅色模式";
  elements.themeButton.title = normalized === "dark" ? "当前：深色模式，点击切换" : "当前：浅色模式，点击切换";
  document.querySelector('meta[name="theme-color"]').content = normalized === "dark" ? "#0b0c0f" : "#f7f7f8";
}

function setConnection(status, message = "") {
  const ready = status === "ready";
  const failed = status === "error";
  const offline = status === "offline";
  const reconnecting = status === "reconnecting";
  elements.connectionDot.className = `status-dot ${ready ? "ready" : failed ? "error" : offline ? "offline" : "connecting"}`;
  elements.connectionLabel.textContent = ready
    ? "服务器已连接"
    : failed
      ? "连接异常"
      : offline
        ? "网络已断开"
        : reconnecting
          ? "正在重新连接…"
          : "正在连接…";
  if (message && (failed || offline)) elements.connectionLabel.title = message;
  else elements.connectionLabel.removeAttribute("title");
  if (!elements.offlineBanner) return;
  if (ready) {
    elements.offlineBanner.classList.add("hidden");
    elements.offlineBanner.textContent = "";
    return;
  }
  elements.offlineBanner.classList.remove("hidden");
  elements.offlineBanner.classList.toggle("error", failed);
  elements.offlineBanner.textContent = offline
    ? "当前无法连接服务器。请检查蒲公英或其他私网连接；恢复网络后页面会自动重连并刷新状态。"
    : failed
      ? `服务器连接异常${message ? `：${message}` : ""}。页面会继续尝试恢复。`
      : "正在恢复服务器连接，期间不会重复提交新的任务指令…";
}

function openSidebar() {
  closeAllMenus();
  elements.sidebar.classList.add("open");
  elements.sidebarBackdrop.classList.remove("hidden");
}

function closeSidebar() {
  closeAllMenus();
  elements.sidebar.classList.remove("open");
  elements.sidebarBackdrop.classList.add("hidden");
}

function syncPinnedThreads(threads, { replace = false } = {}) {
  if (replace) state.pinned.clear();
  for (const thread of threads) {
    if (thread.isPinned) state.pinned.add(thread.id);
    else if (!state.legacyPins.has(thread.id)) state.pinned.delete(thread.id);
  }
}

function migrateLegacyPins(threads) {
  for (const thread of threads) {
    if (!state.legacyPins.has(thread.id) || thread.isPinned || state.pinMigrations.has(thread.id)) continue;
    state.pinMigrations.add(thread.id);
    state.pinned.add(thread.id);
    api(`/api/threads/${encodeURIComponent(thread.id)}/pin`, {
      method: "POST",
      body: JSON.stringify({ isPinned: true }),
    }).then(() => {
      thread.isPinned = true;
      state.legacyPins.delete(thread.id);
      if (state.legacyPins.size) localStorage.setItem("codex-pwa-pins", JSON.stringify([...state.legacyPins]));
      else localStorage.removeItem("codex-pwa-pins");
    }).catch((error) => {
      state.pinned.delete(thread.id);
      console.warn("Unable to migrate a legacy pinned task", error);
    }).finally(() => {
      state.pinMigrations.delete(thread.id);
      renderThreads();
    });
  }
}

const THREAD_LIST_MODES = new Set(["recent", "all", "archived"]);
const RECENT_THREAD_WINDOW_SECONDS = 7 * 24 * 60 * 60;

function threadRecencyEpoch(thread) {
  const value = Number(thread?.recencyAt ?? thread?.updatedAt ?? thread?.createdAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function isRecentThread(thread, now = Date.now() / 1000) {
  return threadRecencyEpoch(thread) >= now - RECENT_THREAD_WINDOW_SECONDS;
}

function syncListModeTabs() {
  const mode = state.threadListMode;
  const tabs = [
    [elements.recentTab, mode === "recent"],
    [elements.allHistoryTab, mode === "all"],
    [elements.archivedTab, mode === "archived"],
  ];
  for (const [tab, active] of tabs) {
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
}

function setListMode(mode) {
  const normalized = THREAD_LIST_MODES.has(mode) ? mode : "recent";
  closeAllMenus();
  state.threadListMode = normalized;
  syncListModeTabs();
  state.threadCursor = null;
  loadThreads().catch((error) => showToast(error.message));
}

function positionFloatingMenu(menu) {
  if (!menu?.anchor?.isConnected || !menu.element?.isConnected) {
    closeAllMenus();
    return;
  }
  const anchor = menu.anchor.getBoundingClientRect();
  const box = menu.element.getBoundingClientRect();
  const gap = 6;
  const left = Math.min(
    Math.max(8, anchor.right - box.width),
    Math.max(8, window.innerWidth - box.width - 8),
  );
  const below = anchor.bottom + gap;
  const top = below + box.height <= window.innerHeight - 8
    ? below
    : Math.max(8, anchor.top - box.height - gap);
  menu.element.style.left = `${left}px`;
  menu.element.style.top = `${top}px`;
  menu.element.style.visibility = "visible";
}

function openFloatingMenu(anchor, owner, actions) {
  const sameMenu = state.floatingMenu?.anchor === anchor;
  closeAllMenus();
  if (sameMenu) return;
  const popover = el("div", "popover-menu floating-popover");
  popover.setAttribute("role", "menu");
  for (const action of actions) {
    const control = action.href ? el("a", action.danger ? "danger" : "", action.label) : el("button", action.danger ? "danger" : "", action.label);
    if (action.href) {
      control.href = action.href;
      if (action.download) control.download = action.download;
      if (action.target) {
        control.target = action.target;
        control.rel = "noopener noreferrer";
      }
    } else {
      control.type = "button";
    }
    control.setAttribute("role", "menuitem");
    control.addEventListener("click", () => {
      if (action.href) setTimeout(closeAllMenus, 0);
      else closeAllMenus();
      action.handler?.();
    });
    popover.append(control);
  }
  anchor.setAttribute("aria-expanded", "true");
  owner?.classList.add("menu-open");
  state.floatingMenu = { anchor, owner, element: popover };
  popover.style.visibility = "hidden";
  document.body.append(popover);
  requestAnimationFrame(() => positionFloatingMenu(state.floatingMenu));
}

function openThreadActionMenu(thread) {
  if (!thread) return;
  closeAllMenus();
  state.threadActionTargetId = thread.id;
  state.threadActionTargetArchived = Boolean(thread.archived);
  elements.threadActionTitle.textContent = threadTitle(thread);
  elements.actionPinThreadButton.textContent = state.pinned.has(thread.id) ? "取消置顶" : "置顶";
  elements.actionArchiveThreadButton.textContent = thread.archived ? "恢复" : "归档";
  if (!elements.threadActionDialog.open) elements.threadActionDialog.showModal();
}

function wireThreadLongPress(main, card, thread) {
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
      openThreadActionMenu(thread);
    }, 520);
  });
  main.addEventListener("pointermove", (event) => {
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
  });
  for (const eventName of ["pointerup", "pointercancel", "pointerleave"]) main.addEventListener(eventName, cancel);
  main.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    cancel();
    openThreadActionMenu(thread);
  });
  main.addEventListener("click", (event) => {
    if (suppressClick) {
      event.preventDefault();
      suppressClick = false;
      return;
    }
    openThread(thread.id, { archived: Boolean(thread.archived) });
  });
}

function createThreadCard(thread) {
  const card = el("article", `thread-card${state.selectedThread?.id === thread.id ? " active" : ""}`);
  const main = el("button", "thread-main");
  main.type = "button";
  const titleLine = el("div", "thread-title-line");
  const status = statusInfo(thread.status);
  titleLine.append(el("span", `thread-status ${status.type}`));
  if (state.pinned.has(thread.id)) titleLine.append(el("span", "thread-pin", "◆"));
  titleLine.append(el("span", "thread-title", threadTitle(thread)));
  const preview = el("span", "thread-preview", threadPreview(thread));
  const meta = el("span", "thread-meta");
  meta.append(el("span", "", status.label), el("span", "", "·"), el("span", "", thread.gitInfo?.branch || sourceLabel(thread)));
  main.append(titleLine, preview, meta);
  wireThreadLongPress(main, card, thread);

  const time = el("span", "thread-time", formatRelative(thread.recencyAt || thread.updatedAt));
  time.title = formatAbsolute(thread.updatedAt);
  const menu = el("div", "thread-menu");
  const menuButton = el("button", "thread-menu-button", "•••");
  menuButton.type = "button";
  menuButton.setAttribute("aria-label", "任务操作");
  menuButton.setAttribute("aria-haspopup", "menu");
  menuButton.setAttribute("aria-expanded", "false");
  const actions = [
    { label: state.pinned.has(thread.id) ? "取消置顶" : "置顶", handler: () => togglePin(thread.id) },
    { label: "重命名", handler: () => openRenameDialog(thread) },
    { label: "复制任务 ID", handler: () => copyThreadId(thread.id) },
    {
      label: thread.archived ? "恢复" : "归档",
      danger: !thread.archived,
      handler: () => thread.archived ? unarchiveThread(thread.id) : archiveThread(thread.id),
    },
  ];
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openFloatingMenu(menuButton, card, actions);
  });
  menu.append(menuButton);
  card.append(main, time, menu);
  return card;
}

function renderThreads() {
  if (state.floatingMenu) {
    state.threadRenderPending = true;
    return;
  }
  state.threadRenderPending = false;
  elements.threadList.replaceChildren();
  const visibleThreads = state.threadListMode === "recent"
    ? state.threads.filter((thread) => isRecentThread(thread))
    : state.threads;
  if (!visibleThreads.length) {
    const emptyCopy = state.query
      ? ["没有匹配的会话", "换一个关键词试试。"]
      : state.threadListMode === "recent"
        ? ["近 7 天内没有会话", "近 7 天创建或更新的未归档会话会显示在这里。"]
        : state.threadListMode === "archived"
          ? ["没有已归档会话", "归档后的会话会显示在这里。"]
          : ["还没有历史会话", "新建会话后，它会显示在全部历史会话中。"];
    const empty = el("div", "empty-list");
    empty.append(
      el("strong", "", emptyCopy[0]),
      el("p", "", emptyCopy[1]),
    );
    elements.threadList.append(empty);
    return;
  }

  const sorted = [...visibleThreads].sort((a, b) => {
    const pinDelta = Number(state.pinned.has(b.id)) - Number(state.pinned.has(a.id));
    return pinDelta || threadRecencyEpoch(b) - threadRecencyEpoch(a);
  });
  const groups = new Map();
  for (const thread of sorted) {
    const key = thread.cwd || "未知目录";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(thread);
  }
  for (const [cwd, threads] of groups) {
    const group = el("section", "thread-group");
    const heading = el("div", "thread-group-heading");
    const name = el("span", "", basename(cwd));
    name.title = cwd;
    heading.append(name, el("small", "", String(threads.length)));
    group.append(heading, ...threads.map(createThreadCard));
    elements.threadList.append(group);
  }
}

async function loadThreads({ silent = false, append = false } = {}) {
  if (append && (!state.threadCursor || state.threadsLoadingMore)) return;
  const sequence = ++state.threadLoadSequence;
  if (!silent || append) closeAllMenus();
  if (!silent && !append) {
    elements.threadList.replaceChildren();
    const loading = el("div", "loading-row");
    loading.append(el("span", "spinner"), el("span", "", "正在同步任务…"));
    elements.threadList.append(loading);
  }
  const listArchived = state.threadListMode === "archived";
  const params = new URLSearchParams({ archived: String(listArchived) });
  if (state.query) params.set("search", state.query);
  params.set("limit", "50");
  if (append && state.threadCursor) params.set("cursor", state.threadCursor);
  state.threadsLoadingMore = append;
  elements.loadMoreThreadsButton.disabled = append;
  if (append) elements.loadMoreThreadsButton.textContent = "正在加载…";
  try {
    const result = await api(`/api/threads?${params}`);
    if (sequence !== state.threadLoadSequence) return;
    const page = (result.data || []).map((thread) => ({ ...thread, archived: listArchived }));
    if (append) {
      const known = new Set(state.threads.map((thread) => thread.id));
      state.threads.push(...page.filter((thread) => !known.has(thread.id)));
    } else {
      state.threads = page;
    }
    state.threadCursor = result.nextCursor || null;
    if (state.threadListMode === "recent" && page.some((thread) => !isRecentThread(thread))) {
      // thread/list is ordered by recency, so once a page crosses the seven-day
      // boundary there cannot be a newer matching conversation on later pages.
      state.threadCursor = null;
    }
    syncPinnedThreads(page, { replace: !append });
    migrateLegacyPins(page);
    renderThreads();
  } finally {
    if (sequence === state.threadLoadSequence) {
      state.threadsLoadingMore = false;
      elements.loadMoreThreadsButton.disabled = false;
      elements.loadMoreThreadsButton.textContent = "加载更多任务";
      elements.loadMoreThreadsButton.classList.toggle("hidden", !state.threadCursor);
    }
  }
}

function scheduleThreadRefresh(delay = 220) {
  clearTimeout(state.threadRefreshTimer);
  state.threadRefreshTimer = setTimeout(() => {
    loadThreads({ silent: true }).catch(() => {});
  }, delay);
}

const refreshVisibleState = debounce(() => {
  if (!state.auth.authenticated || document.visibilityState === "hidden" || navigator.onLine === false) return;
  Promise.all([loadStatus(), loadThreads({ silent: true })]).catch(() => {});
}, 200);

async function runVisibleRecovery() {
  if (!state.auth.authenticated || document.visibilityState === "hidden" || navigator.onLine === false) return;
  if (state.visibleRecoveryPromise) return state.visibleRecoveryPromise;
  const selectedId = state.selectedThread?.id;
  const task = (async () => {
    // Reconcile the global snapshot first. Opening the selected thread then
    // becomes the newest, authoritative view of its active writer state.
    await Promise.all([loadStatus(), loadThreads({ silent: true })]);
    if (selectedId && state.selectedThread?.id === selectedId) {
      await openThread(selectedId, { silent: true, preserveScroll: true });
    }
  })().catch(() => {}).finally(() => {
    if (state.visibleRecoveryPromise === task) state.visibleRecoveryPromise = null;
  });
  state.visibleRecoveryPromise = task;
  return task;
}

const recoverVisibleState = debounce(() => {
  if (navigator.onLine === false) return;
  runVisibleRecovery().catch(() => {});
}, 260);

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
    showToast(`置顶状态保存失败：${error.message}`);
  }
}

function openRenameDialog(thread = state.selectedThread) {
  if (!thread) return;
  state.renameTargetId = thread.id;
  elements.renameInput.value = threadTitle(thread);
  elements.renameDialog.showModal();
  setTimeout(() => elements.renameInput.select(), 40);
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
    showToast("任务已重命名");
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
}

async function archiveThread(threadId) {
  const thread = state.threads.find((item) => item.id === threadId) || state.selectedThread;
  const confirmed = await requestConfirmation({
    eyebrow: "ARCHIVE TASK",
    title: "归档这个任务？",
    message: `${thread ? threadTitle(thread) : "此会话"}\n${thread?.cwd || ""}\n\n归档后会从未归档会话列表移到“已归档会话”，之后仍可恢复。`,
    confirmLabel: "确认归档",
  });
  if (!confirmed) return;
  try {
    await api(`/api/threads/${encodeURIComponent(threadId)}/archive`, { method: "POST", body: "{}" });
    state.threads = state.threads.filter((thread) => thread.id !== threadId);
    if (state.selectedThread?.id === threadId) clearSelectedThread();
    renderThreads();
    showToast("会话已归档，可在“已归档会话”中恢复");
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
    showToast("会话已恢复到未归档历史列表");
  } catch (error) {
    showToast(error.message);
  }
}

function clearSelectedThread({ updateRoute = true } = {}) {
  saveThreadDraft(state.selectedThread?.id);
  clearStreamingRenderTimers();
  state.uploadRequest?.abort();
  clearUploadQueue("composer");
  state.openThreadSequence += 1;
  state.selectedThread = null;
  state.activeTurnId = null;
  state.goal = null;
  state.goalSupported = null;
  state.goalLoading = false;
  state.goalActionPending = false;
  state.itemNodes.clear();
  state.itemTurns.clear();
  state.itemText.clear();
  state.pendingUserMessages.length = 0;
  state.artifacts.clear();
  state.fileChanges.clear();
  state.loadedTurnIds.clear();
  state.historyCursor = null;
  state.historyLoading = false;
  state.historyComplete = false;
  state.historyCompleteLoading = false;
  state.historyCompleteCursor = null;
  state.historyCompleteStarted = false;
  state.historyMemoryLimited = false;
  state.historyRetainedChars = 0;
  state.historyTurnChars.clear();
  state.historyWindow = { enabled: false, start: 0, end: 0, size: 160 };
  resetHistoryContext();
  state.historyNodes = {
    threadId: null,
    data: [],
    nextCursor: null,
    error: "",
    loading: false,
    loadingAll: false,
    focusLoading: false,
    complete: false,
    renderFrame: 0,
    rangeStart: -1,
    rangeEnd: -1,
  };
  elements.historyNodesLoading?.classList.add("hidden");
  elements.historyNodesList?.classList.remove("focus-loading");
  if (elements.historyNodesSearch) elements.historyNodesSearch.disabled = false;
  if (elements.historyNodesDialog?.open) elements.historyNodesDialog.close();
  elements.messages.replaceChildren(elements.historyControls);
  updateHistoryControls();
  elements.chatView.classList.add("hidden");
  elements.emptyState.classList.remove("hidden");
  elements.chatTitle.textContent = "Codex Remote";
  elements.chatMeta.textContent = "点击左侧主菜单查看历史会话";
  updateTurnControls();
  updateChatActions();
  if (updateRoute) updateThreadRoute(null);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function mathPlaceholder(tex, displayMode) {
  const tag = displayMode ? "div" : "span";
  const mode = displayMode ? "block" : "inline";
  return `<${tag} class="math-shell ${mode}">${escapeHtml(tex)}</${tag}>`;
}

const markdown = new Marked({
  breaks: true,
  gfm: true,
});
markdown.use({ extensions: createMathExtensions(mathPlaceholder) });

function enhanceCodeBlocks(container) {
  for (const pre of [...container.querySelectorAll("pre")]) {
    if (pre.closest(".code-block")) continue;
    const code = pre.querySelector(":scope > code");
    const language = [...(code?.classList || [])]
      .find((className) => className.startsWith("language-"))
      ?.slice("language-".length) || "code";
    const wrapper = el("div", "code-block");
    const heading = el("div", "code-heading");
    const copy = el("button", "copy-code", "复制");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(code?.textContent || pre.textContent || "");
      copy.textContent = "已复制";
      setTimeout(() => { copy.textContent = "复制"; }, 1200);
    });
    heading.append(el("span", "", language), copy);
    pre.replaceWith(wrapper);
    wrapper.append(heading, pre);
  }
}

function enhanceTables(container) {
  for (const table of [...container.querySelectorAll("table")]) {
    if (table.closest(".markdown-table-scroll")) continue;
    const wrapper = el("div", "markdown-table-scroll");
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "可横向滚动的表格");
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
}

function renderMath(container) {
  for (const shell of container.querySelectorAll(".math-shell")) {
    const tex = shell.textContent || "";
    const displayMode = shell.classList.contains("block");
    katex.render(tex, shell, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
      maxExpand: 1_000,
      maxSize: 50,
    });
  }
}

function renderMarkdown(container, source) {
  const normalizedSource = normalizeMarkdownFileLinks(source);
  const html = markdown.parse(normalizedSource);
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "srcset"],
  });
  container.replaceChildren(fragment);
  for (const link of container.querySelectorAll("a[href]")) {
    const localPath = serverFilePath(link.getAttribute("href"), state.roots);
    if (localPath) {
      link.href = filePreviewHref(localPath);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.classList.add("server-file-link");
      link.dataset.fileType = localPath.split(".").at(-1)?.toLowerCase() || "file";
      link.title = `预览服务器文件：${localPath}`;
    } else if (/^https?:\/\//i.test(link.href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  for (const image of [...container.querySelectorAll("img[src]")]) {
    const localPath = serverFilePath(image.getAttribute("src"), state.roots);
    if (!localPath) continue;
    const previewHref = filePreviewHref(localPath);
    image.src = fileRawHref(localPath);
    image.classList.add("inline-server-image");
    image.dataset.serverPath = localPath;
    image.title = `预览服务器图片：${localPath}`;
    const existingLink = image.closest("a[href]");
    if (existingLink) {
      existingLink.href = previewHref;
      existingLink.target = "_blank";
      existingLink.rel = "noopener noreferrer";
      existingLink.classList.add("inline-server-image-link");
    } else {
      const previewLink = el("a", "inline-server-image-link");
      previewLink.href = previewHref;
      previewLink.target = "_blank";
      previewLink.rel = "noopener noreferrer";
      image.replaceWith(previewLink);
      previewLink.append(image);
    }
  }
  renderMath(container);
  enhanceTables(container);
  enhanceCodeBlocks(container);
}

function shouldFollowOutput() {
  return elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 150;
}

function scrollToBottom(force = false) {
  if (force || shouldFollowOutput()) elements.messages.scrollTop = elements.messages.scrollHeight;
}

function createMessageRow(role) {
  const row = el("article", `message-row ${role}`);
  if (role !== "user") row.append(el("div", "message-avatar", role === "assistant" ? "C" : "i"));
  const body = el("div", "message-body");
  row.append(body);
  return { row, body };
}

function turnGroup(turnId, { create = false } = {}) {
  if (!turnId) return null;
  let group = [...elements.messages.querySelectorAll(".turn-group")]
    .find((candidate) => candidate.dataset.turnId === turnId);
  if (!group && create) {
    group = el("section", "turn-group");
    group.dataset.turnId = turnId;
    elements.messages.append(group);
    state.loadedTurnIds.add(turnId);
  }
  return group;
}

function placeNodeInContainer(node, container) {
  if (node && container && node.parentNode !== container) container.append(node);
}

function userMessageText(item) {
  if (typeof item?.text === "string") return item.text;
  return (item?.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function renderUserMessage(item, container = elements.messages, options = {}) {
  const text = userMessageText(item);
  if (!text) return null;
  const itemId = String(item.id || "");
  const existing = itemId ? state.itemNodes.get(itemId) : null;
  if (existing?.type === "user") {
    existing.body.textContent = text;
    existing.element.classList.remove("optimistic");
    placeNodeInContainer(existing.element, container);
    return existing.element;
  }

  if (itemId && !itemId.startsWith("local-")) {
    const pendingNode = reconcilePendingUserMessage({
      pendingMessages: state.pendingUserMessages,
      itemNodes: state.itemNodes,
      itemTurns: state.itemTurns,
      threadId: state.selectedThread?.id || null,
      itemId,
      text,
    });
    if (pendingNode) {
      pendingNode.body.textContent = text;
      pendingNode.element.classList.remove("optimistic");
      pendingNode.element.dataset.itemId = itemId;
      placeNodeInContainer(pendingNode.element, container);
      return pendingNode.element;
    }
  }

  const { row, body } = createMessageRow("user");
  body.textContent = text;
  if (itemId) row.dataset.itemId = itemId;
  container.append(row);
  if (itemId) state.itemNodes.set(itemId, { type: "user", element: row, body });
  if (itemId && options.turnId) state.itemTurns.set(itemId, options.turnId);
  return row;
}

function renderOptimisticUserMessage(text, { turnId = null } = {}) {
  const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const container = turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages;
  const row = renderUserMessage({ id, content: [{ type: "text", text }] }, container, { turnId });
  if (!row) return null;
  row.classList.add("optimistic");
  state.pendingUserMessages.push({
    id,
    threadId: state.selectedThread?.id || null,
    turnId,
    text: normalizeUserMessageText(text),
  });
  return { id, element: row };
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
}

function renderAssistantMessage(itemId, text, streaming = false, container = elements.messages, options = {}) {
  if (!streaming) {
    const timer = state.streamRenderTimers.get(itemId);
    if (timer) clearTimeout(timer);
    state.streamRenderTimers.delete(itemId);
    state.streamFollowItems.delete(itemId);
  }
  const existing = state.itemNodes.get(itemId);
  if (existing?.type === "assistant") {
    renderMarkdown(existing.body, text);
    existing.element.classList.toggle("streaming", streaming);
    placeNodeInContainer(existing.element, container);
    suppressRedundantGeneratedArtifacts(container);
    return existing.element;
  }
  const { row, body } = createMessageRow("assistant");
  row.classList.toggle("streaming", streaming);
  renderMarkdown(body, text);
  container.append(row);
  state.itemNodes.set(itemId, { type: "assistant", element: row, body });
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
  }, STREAM_RENDER_INTERVAL_MS));
}

function activityCard(kind, title, status = "") {
  const details = el("details", `activity-card ${kind}-card`);
  const summary = el("summary");
  const icons = { command: ">_", file: "±", tool: "◇", reasoning: "∿", activity: "·" };
  summary.append(el("span", "activity-icon", icons[kind] || "·"), el("span", "activity-title", title));
  const statusWrap = el("span", "activity-status");
  if (status) statusWrap.append(el("span", `status-pill ${status}`, statusLabel(status)));
  summary.append(statusWrap);
  details.append(summary);
  return { details, summary, statusWrap };
}

function statusLabel(status) {
  return ({ inProgress: "运行中", completed: "完成", failed: "失败", declined: "已拒绝" })[status] || status || "";
}

function commandTitle(command) {
  const value = String(command || "正在执行命令").replace(/\s+/g, " ").trim();
  return value.length > 100 ? `${value.slice(0, 98)}…` : value;
}

function collapsedLongText(text, limit) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  const headLength = Math.floor(limit * 0.68);
  const tailLength = limit - headLength;
  const hidden = value.length - limit;
  return `${value.slice(0, headLength)}\n\n… 已折叠 ${hidden.toLocaleString("zh-CN")} 个字符 …\n\n${value.slice(-tailLength)}`;
}

function boundedLiveText(value, limit = MAX_LIVE_TEXT_CHARS) {
  const text = String(value || "");
  if (text.length <= limit) return { text, truncated: false };
  const available = Math.max(1, limit - LIVE_TEXT_TRUNCATION_MARKER.length);
  const headLength = Math.floor(available * 0.28);
  return {
    text: `${text.slice(0, headLength)}${LIVE_TEXT_TRUNCATION_MARKER}${text.slice(-(available - headLength))}`,
    truncated: true,
  };
}

function appendBoundedLiveText(current, delta, limit = MAX_LIVE_TEXT_CHARS) {
  const value = String(current || "");
  const addition = String(delta || "");
  const markerIndex = value.indexOf(LIVE_TEXT_TRUNCATION_MARKER);
  if (markerIndex < 0) return boundedLiveText(`${value}${addition}`, limit);
  const head = value.slice(0, markerIndex);
  const tail = `${value.slice(markerIndex + LIVE_TEXT_TRUNCATION_MARKER.length)}${addition}`;
  const tailLimit = Math.max(1, limit - LIVE_TEXT_TRUNCATION_MARKER.length - head.length);
  return { text: `${head}${LIVE_TEXT_TRUNCATION_MARKER}${tail.slice(-tailLimit)}`, truncated: true };
}

function paintExpandableOutput(node, { limit, label, emptyText = "等待输出…" }) {
  const value = String(node.fullText || "");
  const totalLength = node.outputLength || value.length;
  const truncated = Boolean(node.remoteTruncated || node.memoryTruncated) || value.length > limit;
  node.output.textContent = value ? node.expanded ? value : collapsedLongText(value, limit) : emptyText;
  node.toggle.classList.toggle("hidden", !truncated);
  node.toggle.disabled = Boolean(node.remoteTruncated && node.remoteUnavailable);
  node.toggle.textContent = node.remoteTruncated && node.remoteUnavailable
    ? `${label}过长，仅保留首尾（${totalLength.toLocaleString("zh-CN")} 字符）`
    : node.expanded
      ? `收起${label}`
      : node.memoryTruncated
        ? `展开保留的${label}（共 ${totalLength.toLocaleString("zh-CN")} 字符）`
        : `展开完整${label}（${totalLength.toLocaleString("zh-CN")} 字符）`;
}

async function toggleCommandOutput(itemId, node) {
  if (node.remoteTruncated && node.remoteUnavailable) return;
  if (node.remoteTruncated) {
    node.toggle.disabled = true;
    node.toggle.textContent = "正在载入完整输出…";
    try {
      const result = await api(`/api/threads/${encodeURIComponent(node.threadId)}/outputs/${encodeURIComponent(itemId)}`);
      node.fullText = result.output || "";
      node.outputLength = node.fullText.length;
      node.remoteTruncated = false;
      node.remoteUnavailable = false;
      node.memoryTruncated = false;
      node.expanded = true;
    } catch (error) {
      showToast(error.message, 5200);
    } finally {
      node.toggle.disabled = false;
      paintExpandableOutput(node, { limit: COMMAND_OUTPUT_PREVIEW_CHARS, label: "输出" });
    }
    return;
  }
  node.expanded = !node.expanded;
  paintExpandableOutput(node, { limit: COMMAND_OUTPUT_PREVIEW_CHARS, label: "输出" });
}

function scheduleCommandOutputRender(itemId, node, follow = false) {
  node.followOutput ||= follow;
  if (state.commandRenderTimers.has(itemId)) return;
  state.commandRenderTimers.set(itemId, setTimeout(() => {
    state.commandRenderTimers.delete(itemId);
    paintExpandableOutput(node, { limit: COMMAND_OUTPUT_PREVIEW_CHARS, label: "输出" });
    if (node.followOutput) requestAnimationFrame(() => scrollToBottom(true));
    node.followOutput = false;
  }, STREAM_RENDER_INTERVAL_MS));
}

function renderCommand(item, container = elements.messages) {
  const existing = state.itemNodes.get(item.id);
  if (existing?.type === "command") {
    const timer = state.commandRenderTimers.get(item.id);
    if (timer) clearTimeout(timer);
    state.commandRenderTimers.delete(item.id);
    existing.title.textContent = commandTitle(item.command);
    if (item.outputTruncated) {
      const alreadyHasFullOutput = existing.fullText.length >= Number(item.outputLength || 0);
      if (!alreadyHasFullOutput) existing.fullText = item.aggregatedOutput || existing.fullText;
      existing.remoteTruncated = !alreadyHasFullOutput;
      existing.remoteUnavailable = existing.remoteTruncated && item.fullOutputAvailable === false;
      existing.memoryTruncated = false;
      existing.outputLength = Number(item.outputLength || existing.fullText.length);
    } else if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput) {
      const bounded = boundedLiveText(item.aggregatedOutput, MAX_LIVE_COMMAND_CHARS);
      existing.fullText = bounded.text;
      existing.remoteTruncated = false;
      existing.remoteUnavailable = false;
      existing.memoryTruncated = bounded.truncated;
      existing.outputLength = item.aggregatedOutput.length;
    }
    paintExpandableOutput(existing, { limit: COMMAND_OUTPUT_PREVIEW_CHARS, label: "输出" });
    existing.status.className = `status-pill ${item.status || ""}`;
    existing.status.textContent = statusLabel(item.status);
    existing.element.open = item.status === "inProgress" || item.status === "failed";
    updateCommandMeta(existing.meta, item);
    placeNodeInContainer(existing.element, container);
    return existing.element;
  }
  const card = activityCard("command", commandTitle(item.command), item.status || "inProgress");
  const title = card.summary.querySelector(".activity-title");
  const status = card.statusWrap.querySelector(".status-pill");
  const content = el("div", "activity-content");
  const output = el("pre", "terminal-output");
  const toggle = el("button", "output-toggle hidden", "展开完整输出");
  toggle.type = "button";
  const meta = el("div", "activity-meta");
  updateCommandMeta(meta, item);
  content.append(output, toggle, meta);
  card.details.append(content);
  card.details.open = item.status === "inProgress" || item.status === "failed";
  container.append(card.details);
  const initialOutput = String(item.aggregatedOutput || "");
  const boundedOutput = item.outputTruncated
    ? { text: initialOutput, truncated: false }
    : boundedLiveText(initialOutput, MAX_LIVE_COMMAND_CHARS);
  const node = {
    type: "command", element: card.details, title, status, output, toggle, meta,
    fullText: boundedOutput.text, expanded: false, followOutput: false,
    remoteTruncated: Boolean(item.outputTruncated),
    remoteUnavailable: Boolean(item.outputTruncated && item.fullOutputAvailable === false),
    memoryTruncated: boundedOutput.truncated,
    outputLength: Number(item.outputLength || initialOutput.length),
    threadId: state.selectedThread?.id || "",
  };
  toggle.addEventListener("click", () => toggleCommandOutput(item.id, node));
  paintExpandableOutput(node, { limit: COMMAND_OUTPUT_PREVIEW_CHARS, label: "输出" });
  state.itemNodes.set(item.id, node);
  return card.details;
}

function updateCommandMeta(meta, item) {
  meta.replaceChildren();
  if (item.cwd) meta.append(el("span", "", `目录 ${item.cwd}`));
  if (item.exitCode !== null && item.exitCode !== undefined) meta.append(el("span", "", `退出码 ${item.exitCode}`));
  if (item.durationMs !== null && item.durationMs !== undefined) meta.append(el("span", "", `${(item.durationMs / 1000).toFixed(1)} 秒`));
}

function renderDiff(diff) {
  const lines = String(diff || "暂无差异内容").split("\n");
  const view = el("div", "diff-view");
  const rows = el("div", "diff-rows");
  const controls = el("div", "diff-controls");
  let rendered = 0;

  function appendChunk() {
    const end = nextDiffChunkEnd(lines.length, rendered, DIFF_CHUNK_SIZE);
    const fragment = document.createDocumentFragment();
    for (let index = rendered; index < end; index += 1) {
      const line = lines[index];
      const type = line.startsWith("+") && !line.startsWith("+++") ? "add"
        : line.startsWith("-") && !line.startsWith("---") ? "remove"
          : line.startsWith("@@") ? "hunk" : "";
      const row = el("div", `diff-line ${type}`.trim());
      row.append(el("span", "diff-number", String(index + 1)), el("span", "diff-text", line || " "));
      fragment.append(row);
    }
    rows.append(fragment);
    rendered = end;
    controls.replaceChildren();
    if (rendered < lines.length) {
      const more = el("button", "diff-load-more", `继续显示（${rendered}/${lines.length} 行）`);
      more.type = "button";
      more.addEventListener("click", appendChunk);
      controls.append(more);
    }
  }

  view.append(rows, controls);
  appendChunk();
  return view;
}

function attachLazyDiff(details, diff, { open = false } = {}) {
  const lineCount = countDiffLines(diff);
  const placeholder = el(
    "div",
    "diff-placeholder",
    lineCount ? `展开后载入 ${lineCount.toLocaleString("zh-CN")} 行差异` : "暂无差异内容",
  );
  details.append(placeholder);
  let loaded = false;
  const load = () => {
    if (!details.open || loaded) return;
    loaded = true;
    placeholder.replaceWith(renderDiff(diff));
  };
  details.addEventListener("toggle", load);
  if (open) {
    details.open = true;
    load();
  }
}

function kindLabel(kind) {
  if (typeof kind === "string") return kind;
  return Object.keys(kind || {})[0] || "修改";
}

function collectFileChanges(changes = [], { renderPanel = true } = {}) {
  for (const change of changes) {
    if (!change?.path) continue;
    state.fileChanges.set(change.path, change);
  }
  if (renderPanel) renderChangesPanel();
}

function renderFileChange(item, container = elements.messages, { collectChanges = true } = {}) {
  if (collectChanges) collectFileChanges(item.changes || []);
  const existing = state.itemNodes.get(item.id);
  if (existing?.type === "file") existing.element.remove();
  const count = item.changes?.length || 0;
  const card = activityCard("file", count ? `${count} 个文件发生变更` : "正在准备文件变更", item.status || "inProgress");
  const content = el("div", "activity-content file-list");
  for (const change of item.changes || []) {
    const section = el("details", "file-change");
    const heading = el("summary", "file-heading");
    heading.append(el("span", "file-kind", kindLabel(change.kind)), el("span", "", change.path));
    section.append(heading);
    attachLazyDiff(section, change.diff);
    content.append(section);
  }
  card.details.append(content);
  card.details.open = item.status === "inProgress" || item.status === "failed";
  container.append(card.details);
  state.itemNodes.set(item.id, { type: "file", element: card.details });
  return card.details;
}

function renderTool(item, container = elements.messages) {
  const existing = state.itemNodes.get(item.id);
  if (existing?.element) existing.element.remove();
  const name = item.type === "mcpToolCall" ? `${item.server || "MCP"} / ${item.tool || "工具"}` : `${item.namespace ? `${item.namespace} / ` : ""}${item.tool || "工具"}`;
  const card = activityCard("tool", name, item.status || (item.success === false ? "failed" : "completed"));
  const content = el("div", "activity-content");
  const data = {
    arguments: item.arguments,
    result: item.result || item.contentItems,
    error: item.error,
  };
  const output = el("pre", "tool-json");
  const toggle = el("button", "output-toggle hidden", "展开完整工具输出");
  toggle.type = "button";
  const node = { output, toggle, fullText: JSON.stringify(data, null, 2), expanded: false };
  toggle.addEventListener("click", () => {
    node.expanded = !node.expanded;
    paintExpandableOutput(node, { limit: TOOL_OUTPUT_PREVIEW_CHARS, label: "工具输出", emptyText: "暂无输出" });
  });
  paintExpandableOutput(node, { limit: TOOL_OUTPUT_PREVIEW_CHARS, label: "工具输出", emptyText: "暂无输出" });
  content.append(output, toggle);
  card.details.append(content);
  card.details.open = Boolean(item.error || item.status === "failed");
  container.append(card.details);
  state.itemNodes.set(item.id, { type: "tool", element: card.details });
  return card.details;
}

function renderReasoning(item, container = elements.messages) {
  const text = [...(item.summary || []), ...(item.content || [])].join("\n\n");
  const existing = state.itemNodes.get(item.id);
  if (existing?.type === "reasoning") {
    existing.content.textContent = text || "正在分析…";
    placeNodeInContainer(existing.element, container);
    return existing.element;
  }
  const card = activityCard("reasoning", "分析过程", item.status || "");
  card.details.classList.add("reasoning-card");
  const content = el("div", "reasoning-content", text || "正在分析…");
  card.details.append(content);
  container.append(card.details);
  state.itemNodes.set(item.id, { type: "reasoning", element: card.details, content });
  return card.details;
}

function renderPlan(plan, container = elements.messages, itemId = "live-plan") {
  const existing = state.itemNodes.get(itemId);
  const card = el("section", "plan-card");
  const heading = el("div", "plan-heading");
  heading.append(el("span", "", "◫"), el("span", "", "执行计划"));
  const steps = el("div", "plan-steps");
  for (const step of plan?.plan || []) {
    const row = el("div", `plan-step ${step.status || "pending"}`);
    const symbol = step.status === "completed" ? "✓" : step.status === "inProgress" ? "•" : "";
    row.append(el("span", "plan-check", symbol), el("span", "", step.step));
    steps.append(row);
  }
  if (!steps.children.length && plan?.text) steps.append(el("div", "plan-step", plan.text));
  card.append(heading);
  if (plan?.explanation) card.append(el("p", "reasoning-content", plan.explanation));
  card.append(steps);
  if (existing?.element) existing.element.replaceWith(card);
  else container.append(card);
  state.itemNodes.set(itemId, { type: "plan", element: card });
  return card;
}

function renderActivity(item, label, container = elements.messages) {
  const existing = item.id ? state.itemNodes.get(item.id) : null;
  if (existing?.element) existing.element.remove();
  const card = activityCard("activity", label, item.status || "");
  container.append(card.details);
  if (item.id) state.itemNodes.set(item.id, { type: "activity", element: card.details });
  return card.details;
}

function isContextNotice(text) {
  return /\b(?:context|contexts|token|tokens|length|compaction|compact|window)\b|上下文|令牌|压缩|长度/i.test(String(text || ""));
}

function notificationTurnId(params = {}) {
  const explicit = params.turnId || params.turn?.id;
  if (explicit) return String(explicit);
  if (params.threadId && state.selectedThread?.id && params.threadId !== state.selectedThread.id) return null;
  if (state.activeTurnId) return state.activeTurnId;
  return state.selectedThread?.turns?.find((turn) => turn?.status === "inProgress")?.id || null;
}

function renderTurnNotice(text, { turnId = null, kind = "warning", id = "" } = {}) {
  const messageText = String(text || "").trim();
  if (!messageText) return null;
  const container = turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages;
  const noticeKey = `turn-notice:${id || `${kind}:${turnId || "root"}:${messageText}`}`;
  const existing = state.itemNodes.get(noticeKey);
  if (existing?.type === "turnNotice" && existing.element) {
    existing.element.textContent = messageText;
    existing.element.className = `turn-notice ${kind}`;
    existing.element.dataset.noticeText = messageText;
    placeNodeInContainer(existing.element, container);
    return existing.element;
  }
  const notice = el("div", `turn-notice ${kind}`, messageText);
  notice.dataset.noticeText = messageText;
  container.append(notice);
  state.itemNodes.set(noticeKey, { type: "turnNotice", element: notice });
  return notice;
}

function imageArtifactMetadata(item) {
  const artifact = item?.artifact || state.artifacts.get(item?.id);
  if (!artifact || !item?.id) return null;
  const threadId = state.selectedThread?.id || "";
  const base = `/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(item.id)}/raw`;
  return {
    ...artifact,
    id: item.id,
    previewUrl: artifact.previewUrl || base,
    downloadUrl: artifact.downloadUrl || `${base}?download=1`,
  };
}

function renderImageGeneration(item, container = elements.messages) {
  const existing = state.itemNodes.get(item.id);
  if (existing?.element) existing.element.remove();
  const artifact = imageArtifactMetadata(item);
  if (!artifact) {
    const card = activityCard("activity", "正在生成图片", item.status || "inProgress");
    container.append(card.details);
    state.itemNodes.set(item.id, { type: "imageGeneration", element: card.details });
    return card.details;
  }
  state.artifacts.set(item.id, artifact);
  const card = el("section", "artifact-card image-artifact");
  card.dataset.artifactId = item.id;
  const preview = el("a", "artifact-preview");
  preview.href = artifact.previewUrl;
  preview.target = "_blank";
  preview.rel = "noopener noreferrer";
  const image = document.createElement("img");
  image.src = artifact.previewUrl;
  image.alt = "Codex 生成的图片";
  image.loading = "lazy";
  image.decoding = "async";
  preview.append(image);
  const copy = el("div", "artifact-copy");
  copy.append(
    el("strong", "", artifact.name || "Codex 生成图片"),
    el("span", "", `${formatUploadSize(artifact.byteLength || 0)} · 点击图片预览`),
  );
  if (artifact.revisedPrompt) {
    const prompt = el("details", "artifact-prompt");
    prompt.append(el("summary", "", "查看生成提示"), el("p", "", artifact.revisedPrompt));
    copy.append(prompt);
  }
  const actions = el("div", "artifact-actions");
  const open = el("a", "", "预览");
  open.href = artifact.previewUrl;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  const download = el("a", "", "下载");
  download.href = artifact.downloadUrl;
  download.download = artifact.name || "generated-image";
  actions.append(open, download);
  card.append(preview, copy, actions);
  container.append(card);
  state.itemNodes.set(item.id, { type: "imageGeneration", element: card });
  return card;
}

function suppressRedundantGeneratedArtifacts(group) {
  if (!group?.classList?.contains("turn-group") || !group.querySelector(".inline-server-image")) return false;
  for (const card of group.querySelectorAll(".image-artifact[data-artifact-id]")) {
    const artifactId = card.dataset.artifactId;
    card.remove();
    if (artifactId && state.itemNodes.get(artifactId)?.type === "imageGeneration") {
      state.itemNodes.delete(artifactId);
    }
  }
  return true;
}

function renderKnownArtifacts() {
  for (const artifact of state.artifacts.values()) {
    const turnId = artifact.turnId || state.itemTurns.get(artifact.id) || null;
    const group = turnGroup(turnId);
    if (!group) {
      const existing = state.itemNodes.get(artifact.id);
      if (existing?.type === "imageGeneration") {
        existing.element?.remove();
        state.itemNodes.delete(artifact.id);
      }
      continue;
    }
    if (suppressRedundantGeneratedArtifacts(group)) {
      const existing = state.itemNodes.get(artifact.id);
      if (existing?.type === "imageGeneration") {
        existing.element?.remove();
        state.itemNodes.delete(artifact.id);
      }
      continue;
    }
    renderImageGeneration({ id: artifact.id, type: "imageGeneration", status: "completed", artifact }, group);
    if (turnId) state.itemTurns.set(artifact.id, turnId);
  }
}

async function loadThreadArtifacts(threadId) {
  if (!threadId) return;
  const sequence = ++state.artifactLoadSequence;
  const result = await api(`/api/threads/${encodeURIComponent(threadId)}/artifacts`);
  if (sequence !== state.artifactLoadSequence || state.selectedThread?.id !== threadId) return;
  state.artifacts.clear();
  for (const artifact of result.data || []) state.artifacts.set(artifact.id, artifact);
  renderKnownArtifacts();
}

function renderItem(item, container = elements.messages, options = {}) {
  if (!item) return null;
  if (item.id && options.turnId) state.itemTurns.set(item.id, options.turnId);
  if (item.type === "userMessage") return renderUserMessage(item, container, options);
  if (item.type === "agentMessage") {
    const bounded = boundedLiveText(item.text || "");
    state.itemText.set(item.id, bounded.text);
    return renderAssistantMessage(item.id, bounded.text, false, container, options);
  }
  if (item.type === "commandExecution") return renderCommand(item, container);
  if (item.type === "fileChange") return renderFileChange(item, container, options);
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return renderTool(item, container);
  if (item.type === "reasoning") return renderReasoning(item, container);
  if (item.type === "plan") return renderPlan({ text: item.text }, container, item.id);
  if (item.type === "collabAgentToolCall") return renderActivity(item, `协作代理：${item.tool || "操作"} · ${item.status || ""}`, container);
  if (item.type === "subAgentActivity") return renderActivity(item, `子代理：${item.agentPath || item.kind || "活动"}`, container);
  if (item.type === "webSearch") return renderActivity(item, "网页搜索", container);
  if (item.type === "imageView") return renderActivity(item, `查看图片：${item.path || ""}`, container);
  if (item.type === "imageGeneration") return renderImageGeneration(item, container);
  if (item.type === "enteredReviewMode") return renderActivity(item, "进入代码审查模式", container);
  if (item.type === "exitedReviewMode") return renderActivity(item, "代码审查已结束", container);
  if (item.type === "contextCompaction" || item.type === "ContextCompaction"
    || String(item.type || "").toLowerCase() === "contextcompaction") {
    return renderActivity(item, "上下文已压缩", container);
  }
  if (item.type === "historyNotice") {
    const notice = el("div", "history-notice", item.text || "部分历史活动已折叠");
    container.append(notice);
    if (item.id) state.itemNodes.set(item.id, { type: "historyNotice", element: notice });
    return notice;
  }
  return null;
}

function resetHistoryContext() {
  const sequence = Number(state.historyContext?.sequence || 0) + 1;
  state.historyContext = {
    active: false,
    threadId: null,
    targetTurnId: null,
    olderCursor: null,
    newerCursor: null,
    loadingDirection: null,
    deferredUpdates: false,
    sequence,
  };
  elements.messages?.classList.remove("history-context");
}

function updateHistoryControls() {
  if (state.historyMemoryLimited) {
    elements.historyControls.classList.toggle("hidden", !state.selectedThread);
    elements.loadMoreHistoryButton.classList.remove("hidden");
    elements.loadMoreHistoryButton.disabled = true;
    elements.loadMoreHistoryButton.textContent = "已达手机历史缓存上限";
    elements.loadCompleteHistoryButton.classList.remove("hidden");
    elements.loadCompleteHistoryButton.disabled = true;
    elements.loadCompleteHistoryButton.textContent = "重新打开会话后可从最近记录开始";
    elements.historyNodesButton.classList.toggle("hidden", !state.selectedThread);
    elements.historyNodesButton.disabled = state.historyNodes.loading || state.historyNodes.loadingAll;
    return;
  }
  if (state.historyContext.active) {
    const context = state.historyContext;
    const loading = Boolean(context.loadingDirection) || state.historyCompleteLoading;
    const hasMore = Boolean(context.olderCursor || context.newerCursor);
    for (const button of elements.messages.querySelectorAll(".history-context-boundary button")) {
      button.disabled = loading;
    }
    elements.historyControls.classList.remove("hidden");
    elements.loadMoreHistoryButton.classList.remove("hidden");
    elements.loadMoreHistoryButton.disabled = loading || !hasMore;
    elements.loadMoreHistoryButton.textContent = context.loadingDirection
      ? "正在加载历史对话…"
      : hasMore ? "加载更多历史对话" : "已载入全部上下文";
    elements.loadCompleteHistoryButton.classList.remove("hidden");
    elements.loadCompleteHistoryButton.disabled = loading || !hasMore;
    elements.loadCompleteHistoryButton.textContent = state.historyCompleteLoading
      ? "正在加载完整历史对话…"
      : hasMore ? "加载完整历史对话" : "已加载完整历史对话";
    elements.historyNodesButton.classList.remove("hidden");
    elements.historyNodesButton.disabled = state.historyNodes.loading || state.historyNodes.loadingAll;
    return;
  }
  const hasMore = Boolean(state.historyCursor);
  const canLoadMore = !state.activityDetailsLoaded || state.activityDetailsLoading || hasMore || state.historyLoading;
  const canLoadComplete = Boolean(state.selectedThread?.turns?.length)
    && (!state.historyComplete || state.historyCompleteLoading);
  elements.historyControls.classList.toggle("hidden", !state.selectedThread);
  elements.loadMoreHistoryButton.classList.toggle("hidden", !canLoadMore);
  elements.loadMoreHistoryButton.disabled = state.historyLoading || state.activityDetailsLoading;
  elements.loadMoreHistoryButton.textContent = state.historyLoading || state.activityDetailsLoading
    ? "正在加载历史对话…"
    : "加载更多历史对话";
  elements.loadCompleteHistoryButton.classList.toggle("hidden", state.historyComplete && !state.historyCompleteLoading);
  elements.loadCompleteHistoryButton.disabled = state.historyCompleteLoading;
  elements.loadCompleteHistoryButton.textContent = state.historyCompleteLoading
    ? "正在加载完整历史对话…"
    : state.historyComplete
      ? "已加载完整历史对话"
      : state.historyCompleteStarted ? "继续加载完整历史对话" : "加载完整历史对话";
  elements.historyNodesButton.classList.toggle("hidden", !state.selectedThread);
  elements.historyNodesButton.disabled = state.historyNodes.loading || state.historyNodes.loadingAll;
}

function canRetainHistoryPage(rawTurns) {
  const sizes = new Map(state.historyTurnChars);
  let retainedChars = state.historyRetainedChars;
  for (const turn of rawTurns || []) {
    if (!turn?.id) continue;
    const nextSize = JSON.stringify(turn).length;
    retainedChars += nextSize - (sizes.get(turn.id) || 0);
    sizes.set(turn.id, nextSize);
    if (sizes.size > MAX_RETAINED_HISTORY_TURNS || retainedChars > MAX_RETAINED_HISTORY_CHARS) return false;
  }
  return true;
}

function syncHistoryRetention(turns = state.selectedThread?.turns || []) {
  const sizes = new Map();
  let retainedChars = 0;
  for (const turn of turns) {
    if (!turn?.id) continue;
    const size = JSON.stringify(turn).length;
    sizes.set(turn.id, size);
    retainedChars += size;
  }
  state.historyTurnChars = sizes;
  state.historyRetainedChars = retainedChars;
}

function markHistoryMemoryLimited() {
  if (state.historyMemoryLimited) return;
  state.historyMemoryLimited = true;
  updateHistoryControls();
  showToast("已达到手机历史缓存安全上限；重新打开会话可从最近记录重新开始", 7000);
}

function collectTurnFileChanges(turns, { older = false } = {}) {
  const pageChanges = new Map();
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type !== "fileChange") continue;
      for (const change of item.changes || []) {
        if (change?.path) pageChanges.set(change.path, change);
      }
    }
  }
  for (const [path, change] of pageChanges) {
    if (!older || !state.fileChanges.has(path)) state.fileChanges.set(path, change);
  }
}

function syncTurnOutcome(group, turn) {
  group.querySelector("[data-turn-outcome]")?.remove();
  let outcome = null;
  if (turn.status === "failed" && turn.error) {
    outcome = el("div", "turn-error", turn.error.message || "任务执行失败");
  } else if (turn.status === "interrupted") {
    outcome = el("div", "turn-divider", "已停止");
  }
  if (outcome) {
    outcome.dataset.turnOutcome = turn.status;
    group.append(outcome);
  }
}

function createTurnGroup(turn) {
  const group = el("section", "turn-group");
  group.dataset.turnId = turn.id || "";
  for (const item of turn.items || []) renderItem(item, group, { collectChanges: false, turnId: turn.id });
  syncTurnOutcome(group, turn);
  if (turn.status === "inProgress") state.activeTurnId = turn.id;
  return group;
}

function renderTurnsPage(rawTurns, { prepend = false } = {}) {
  const turns = chronologicalTurns(rawTurns, "desc")
    .filter((turn) => turn?.id && !state.loadedTurnIds.has(turn.id));
  if (!turns.length) return 0;
  collectTurnFileChanges(turns, { older: prepend });
  const fragment = document.createDocumentFragment();
  for (const turn of turns) {
    state.loadedTurnIds.add(turn.id);
    fragment.append(createTurnGroup(turn));
  }
  if (prepend) {
    elements.historyControls.after(fragment);
    state.selectedThread.turns = [...turns, ...(state.selectedThread.turns || [])];
  } else {
    elements.messages.append(fragment);
    state.selectedThread.turns = [...(state.selectedThread.turns || []), ...turns];
  }
  syncHistoryRetention();
  return turns.length;
}

function transcriptSignature(turn) {
  const items = turn?.items || [];
  const textLength = items.reduce((sum, item) => (
    sum + String(item?.text || "").length
    + (item?.summary || []).join("").length
    + (item?.content || []).join("").length
  ), 0);
  return `${items.length}:${textLength}:${items.at(-1)?.id || ""}:${turn?.status || ""}`;
}

function mergeActiveTranscript(turn, { force = false } = {}) {
  if (!turn?.id) return false;
  const signature = transcriptSignature(turn);
  if (!force && state.transcriptSignatures.get(turn.id) === signature) return false;
  state.transcriptSignatures.set(turn.id, signature);
  mergeTurnsPage([turn], { replaceItems: true });
  return true;
}

async function restoreActiveTranscript(threadId, turnId, { force = false, follow = false } = {}) {
  if (!threadId || !turnId) return;
  const key = `${threadId}:${turnId}`;
  if (state.transcriptLoads.has(key)) return state.transcriptLoads.get(key);
  const task = (async () => {
    const wasFollowing = follow || shouldFollowOutput();
    const previousHeight = elements.messages.scrollHeight;
    const previousTop = elements.messages.scrollTop;
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}/transcript?turnId=${encodeURIComponent(turnId)}`);
    if (state.selectedThread?.id !== threadId || state.activeTurnId !== turnId) return;
    if (!canRetainHistoryPage([result.turn])) {
      markHistoryMemoryLimited();
      return;
    }
    const changed = mergeActiveTranscript(result.turn, { force });
    if (!changed) return;
    const latest = await api(`/api/threads/${encodeURIComponent(threadId)}/turns?limit=1`).catch(() => null);
    if (latest && state.selectedThread?.id === threadId && state.activeTurnId === turnId) {
      mergeTurnsPage(latest.data || []);
    }
    requestAnimationFrame(() => {
      if (wasFollowing) scrollToBottom(true);
      else elements.messages.scrollTop = previousTop + (elements.messages.scrollHeight - previousHeight);
    });
  })().catch((error) => {
    if (state.selectedThread?.id === threadId && state.activeTurnId === turnId) {
      showToast(`完整运行记录加载失败：${error.message}`, 5200);
    }
  }).finally(() => {
    state.transcriptLoads.delete(key);
  });
  state.transcriptLoads.set(key, task);
  return task;
}

function renderThread(
  thread,
  history = { data: [], nextCursor: null },
  { activeTurnId = null, activeTranscript = null, settings = null, goal = null, goalSupported = null, preserveScroll = false } = {},
) {
  const previousThreadId = state.selectedThread?.id || null;
  if (previousThreadId && previousThreadId !== thread.id) saveThreadDraft(previousThreadId);
  clearStreamingRenderTimers();
  const wasFollowing = shouldFollowOutput();
  const bottomOffset = Math.max(
    0,
    elements.messages.scrollHeight - elements.messages.clientHeight - elements.messages.scrollTop,
  );
  state.selectedThread = thread;
  applyEffectiveSettings(thread.id, settings);
  state.goal = goal || null;
  state.goalSupported = goalSupported;
  state.selectedThread.goal = state.goal;
  if (previousThreadId && previousThreadId !== thread.id) clearUploadQueue("composer");
  state.selectedThread.turns = [];
  state.activeTurnId = null;
  state.itemNodes.clear();
  state.itemTurns.clear();
  state.itemText.clear();
  state.pendingUserMessages.length = 0;
  state.artifacts.clear();
  state.fileChanges.clear();
  state.loadedTurnIds.clear();
  state.historyCursor = history?.nextCursor || null;
  state.historyLoading = false;
  state.activityDetailsLoaded = false;
  state.activityDetailsLoading = false;
  state.historyComplete = false;
  state.historyCompleteLoading = false;
  state.historyCompleteCursor = null;
  state.historyCompleteStarted = false;
  state.historyMemoryLimited = false;
  state.historyRetainedChars = 0;
  state.historyTurnChars.clear();
  state.historyWindow = { enabled: false, start: 0, end: 0, size: 160 };
  resetHistoryContext();
  state.historyNodes = {
    threadId: null,
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
  elements.historyNodesLoading?.classList.add("hidden");
  elements.historyNodesList?.classList.remove("focus-loading");
  if (elements.historyNodesSearch) elements.historyNodesSearch.disabled = false;
  if (elements.historyNodesDialog?.open) elements.historyNodesDialog.close();
  elements.messages.classList.remove("full-history");
  state.rawDiff = "";
  state.plan = null;
  state.tokenUsage = null;
  elements.messages.replaceChildren(elements.historyControls);
  elements.emptyState.classList.add("hidden");
  elements.chatView.classList.remove("hidden");

  renderTurnsPage(history?.data || []);
  if (activeTranscript) mergeActiveTranscript(activeTranscript, { force: true });
  if (activeTurnId) state.activeTurnId = activeTurnId;
  renderChangesPanel();
  renderGoalBar();
  updateHistoryControls();
  updateChatHeader();
  updateTurnControls();
  updateChatActions();
  renderThreads();
  renderInfoPanel();
  updateOptionChips();
  if (previousThreadId !== thread.id) restoreThreadDraft(thread.id);
  requestAnimationFrame(() => {
    if (preserveScroll && !wasFollowing) {
      elements.messages.scrollTop = Math.max(
        0,
        elements.messages.scrollHeight - elements.messages.clientHeight - bottomOffset,
      );
    } else {
      scrollToBottom(true);
    }
  });
}

function applyThreadOwnership(threadId, result) {
  if (result.ownership === "owned") state.ownedThreads.add(threadId);
  else state.ownedThreads.delete(threadId);
  if (result.ownership === "releasing") state.releasingThreads.add(threadId);
  else state.releasingThreads.delete(threadId);
}

function reorderTurnGroups() {
  const order = new Map((state.selectedThread?.turns || []).map((turn, index) => [turn.id, index]));
  const groups = [...elements.messages.querySelectorAll(".turn-group")]
    .sort((left, right) => (order.get(left.dataset.turnId) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.dataset.turnId) ?? Number.MAX_SAFE_INTEGER));
  for (const group of groups) elements.messages.append(group);
  const newer = elements.messages.querySelector('.history-window-nav[data-direction="newer"]');
  if (newer) elements.messages.append(newer);
}

function historyWindowButton(direction, hiddenCount) {
  const shell = el("div", "history-window-nav");
  shell.dataset.direction = direction;
  const button = el(
    "button",
    "",
    direction === "older"
      ? `查看更早的 ${Math.min(hiddenCount, state.historyWindow.size)} 个轮次（尚有 ${hiddenCount} 个）`
      : `查看较新的 ${Math.min(hiddenCount, state.historyWindow.size)} 个轮次（尚有 ${hiddenCount} 个）`,
  );
  button.type = "button";
  button.addEventListener("click", () => shiftHistoryWindow(direction));
  shell.append(button);
  return shell;
}

function historyContextBanner() {
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
  if (copy) copy.textContent = state.historyContext.deferredUpdates
    ? "任务已有新进展"
    : "正在查看所选节点附近的完整记录";
  if (latest) latest.textContent = state.historyContext.deferredUpdates ? "查看最新进展" : "返回最新对话";
}

function markHistoryContextUpdated() {
  if (!state.historyContext.active) return;
  state.historyContext.deferredUpdates = true;
  updateHistoryContextBanner();
}

function historyContextBoundary(direction) {
  const cursor = direction === "older" ? state.historyContext.olderCursor : state.historyContext.newerCursor;
  if (!cursor) return null;
  const shell = el("div", "history-context-boundary");
  const button = el("button", "", direction === "older" ? "↑ 加载更早上下文" : "加载较新上下文 ↓");
  button.type = "button";
  button.disabled = Boolean(state.historyContext.loadingDirection);
  button.addEventListener("click", () => loadHistoryContextPage(direction));
  shell.append(button);
  return shell;
}

function historyContextTurn(turn, index, targetIndex) {
  const group = createTurnGroup(turn);
  if (turn.id === state.historyContext.targetTurnId) group.classList.add("history-context-target");
  if (Math.abs(index - targetIndex) <= 1) return group;
  const wrapper = el("details", "history-context-turn");
  const summary = el("summary", "history-context-turn-summary");
  const prompt = historyNodePreview(historyNodePrompt(turn), 150) || "无文字 Prompt";
  const timestamp = turnTimestamp(turn);
  summary.append(
    el("span", "history-context-turn-direction", index < targetIndex ? "更早" : "较新"),
    el("span", "history-context-turn-prompt", prompt),
    el("span", "history-context-turn-time", timestamp ? formatAbsolute(timestamp) : ""),
  );
  wrapper.append(summary, group);
  return wrapper;
}

function renderHistoryWindow({ start = null, focusTurnId = null, scroll = "preserve" } = {}) {
  const turns = state.selectedThread?.turns || [];
  if (!turns.length) return;
  const size = state.historyWindow.size;
  const windowRange = boundedWindow(turns.length, size, start);
  const { enabled, start: nextStart, end: nextEnd } = windowRange;
  const previousTop = elements.messages.scrollTop;
  const localEntries = [...state.itemNodes.entries()].filter(([itemId]) => String(itemId).startsWith("local-"));
  const localTurnIds = new Map(localEntries.map(([itemId]) => [itemId, state.itemTurns.get(itemId)]));
  state.itemNodes.clear();
  state.itemTurns.clear();
  state.itemText.clear();
  for (const [itemId, node] of localEntries) {
    state.itemNodes.set(itemId, node);
    if (localTurnIds.get(itemId)) state.itemTurns.set(itemId, localTurnIds.get(itemId));
  }
  state.loadedTurnIds.clear();

  const fragment = document.createDocumentFragment();
  const context = state.historyContext.active ? state.historyContext : null;
  if (context) {
    fragment.append(historyContextBanner());
    const olderBoundary = historyContextBoundary("older");
    if (olderBoundary) fragment.append(olderBoundary);
  }
  if (nextStart > 0) fragment.append(historyWindowButton("older", nextStart));
  const targetIndex = context ? turns.findIndex((turn) => turn.id === context.targetTurnId) : -1;
  turns.slice(nextStart, nextEnd).forEach((turn, offset) => {
    const index = nextStart + offset;
    state.loadedTurnIds.add(turn.id);
    fragment.append(context ? historyContextTurn(turn, index, targetIndex) : createTurnGroup(turn));
  });
  if (nextEnd < turns.length) fragment.append(historyWindowButton("newer", turns.length - nextEnd));
  if (context) {
    const newerBoundary = historyContextBoundary("newer");
    if (newerBoundary) fragment.append(newerBoundary);
    elements.messages.replaceChildren(fragment, elements.historyControls);
  } else {
    elements.messages.replaceChildren(elements.historyControls, fragment);
  }
  state.historyWindow = { ...state.historyWindow, enabled, start: nextStart, end: nextEnd };
  elements.messages.classList.toggle("virtual-history", enabled);
  elements.messages.classList.toggle("history-context", Boolean(context));
  renderKnownArtifacts();
  updateHistoryControls();

  requestAnimationFrame(() => {
    if (focusTurnId) {
      const group = turnGroup(focusTurnId);
      group?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (scroll === "bottom") {
      scrollToBottom(true);
    } else if (scroll === "top") {
      elements.messages.scrollTop = 0;
    } else {
      elements.messages.scrollTop = Math.min(previousTop, elements.messages.scrollHeight);
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
  renderHistoryWindow({ start: nextStart, scroll: "top" });
}

function mergeTurnsPage(rawTurns, {
  replaceItems = false, prepend = false, complete = false, deferRender = false,
} = {}) {
  const incomingTurns = chronologicalTurns(rawTurns, "desc").filter((turn) => turn?.id);
  collectTurnFileChanges(incomingTurns);
  const currentTurns = state.selectedThread?.turns || [];
  const windowWasLatest = state.historyWindow.enabled && state.historyWindow.end >= currentTurns.length;
  const currentById = new Map(currentTurns.map((turn) => [turn.id, turn]));
  const turns = incomingTurns.map((turn) => {
    const current = currentById.get(turn.id);
    if (!current || replaceItems) return turn;
    const currentItems = Array.isArray(current.items) ? current.items : [];
    const incomingItems = Array.isArray(turn.items) ? turn.items : [];
    return currentItems.length > incomingItems.length
      ? { ...current, ...turn, items: currentItems }
      : turn;
  });
  let added = 0;
  const incomingIds = new Set(turns.map((turn) => turn.id));
  let canonicalTurns;
  if (prepend || complete) {
    canonicalTurns = [...turns, ...currentTurns.filter((turn) => !incomingIds.has(turn.id))];
  } else {
    canonicalTurns = [...currentTurns];
    for (const turn of turns) {
      const index = canonicalTurns.findIndex((candidate) => candidate.id === turn.id);
      if (index >= 0) canonicalTurns[index] = turn;
      else canonicalTurns.push(turn);
    }
  }
  if (state.selectedThread) state.selectedThread.turns = canonicalTurns;
  syncHistoryRetention(canonicalTurns);
  for (const turn of turns) {
    if (turn.status === "inProgress") state.activeTurnId = turn.id;
  }
  added = turns.filter((turn) => !currentById.has(turn.id)).length;
  if (deferRender) return added;
  if (state.historyWindow.enabled && windowWasLatest && canonicalTurns.length !== currentTurns.length) {
    renderHistoryWindow({
      start: Math.max(0, canonicalTurns.length - state.historyWindow.size),
      scroll: shouldFollowOutput() ? "bottom" : "preserve",
    });
    return added;
  }
  for (const turn of turns) {
    if (state.historyWindow.enabled) {
      const index = canonicalTurns.findIndex((candidate) => candidate.id === turn.id);
      if (index < state.historyWindow.start || index >= state.historyWindow.end) continue;
    }
    let group = [...elements.messages.querySelectorAll(".turn-group")]
      .find((candidate) => candidate.dataset.turnId === turn.id);
    if (!group) {
      group = createTurnGroup(turn);
      elements.messages.append(group);
      state.loadedTurnIds.add(turn.id);
    } else if (replaceItems) {
      const previousTurn = currentById.get(turn.id);
      for (const [itemId, node] of state.itemNodes) {
        if (String(itemId).startsWith("local-")) continue;
        if (state.itemTurns.get(itemId) !== turn.id && !(node?.element && group.contains(node.element))) continue;
        node?.element?.remove();
        state.itemNodes.delete(itemId);
        state.itemTurns.delete(itemId);
        state.itemText.delete(itemId);
      }
      for (const item of [...(previousTurn?.items || []), ...(turn.items || [])]) {
        if (!item?.id) continue;
        state.itemNodes.delete(item.id);
        state.itemTurns.delete(item.id);
        state.itemText.delete(item.id);
      }
      const replacement = createTurnGroup(turn);
      group.replaceWith(replacement);
      group = replacement;
    } else {
      for (const item of turn.items || []) renderItem(item, group, { collectChanges: false, turnId: turn.id });
      syncTurnOutcome(group, turn);
      if (turn.status === "inProgress") state.activeTurnId = turn.id;
    }
  }
  reorderTurnGroups();
  renderKnownArtifacts();
  return added;
}

async function refreshSelectedThread({ preserveScroll = true } = {}) {
  const threadId = state.selectedThread?.id;
  if (!threadId) return;
  if (state.historyContext.active && state.historyContext.threadId === threadId) {
    markHistoryContextUpdated();
    return;
  }
  const sequence = ++state.openThreadSequence;
  const wasFollowing = shouldFollowOutput();
  const params = new URLSearchParams();
  if (!state.selectedThread.archived) params.set("subscribe", "true");
  const suffix = params.size ? `?${params}` : "";
  const result = await api(`/api/threads/${encodeURIComponent(threadId)}${suffix}`);
  if (sequence !== state.openThreadSequence || state.selectedThread?.id !== threadId) return;
  applyThreadOwnership(threadId, result);
  state.selectedThread = { ...state.selectedThread, ...result.thread };
  applyEffectiveSettings(threadId, result.settings);
  applyGoalState(threadId, { goal: result.goal, supported: result.goalSupported });
  mergeTurnsPage(result.history?.data || []);
  if (result.activeTranscript) mergeActiveTranscript(result.activeTranscript);
  if (result.activeTurnId) state.activeTurnId = result.activeTurnId;
  else if (result.thread?.status?.type !== "active") state.activeTurnId = null;
  renderChangesPanel();
  updateChatHeader();
  updateTurnControls();
  updateChatActions();
  renderThreads();
  renderInfoPanel();
  updateOptionChips();
  if (result.goalSupported === undefined) await loadThreadGoal(threadId);
  if (result.activeTranscriptAvailable && state.activeTurnId) {
    await restoreActiveTranscript(threadId, state.activeTurnId);
  }
  await loadThreadArtifacts(threadId).catch(() => {});
  if (result.subscriptionError) showToast(`实时订阅失败，已保留只读历史：${result.subscriptionError}`);
  if (!preserveScroll || wasFollowing) requestAnimationFrame(() => scrollToBottom(true));
}

async function openThread(threadId, {
  silent = false,
  preserveScroll = false,
  updateRoute = true,
  archived = state.selectedThread?.id === threadId ? Boolean(state.selectedThread.archived) : false,
} = {}) {
  if (!threadId) return;
  closeAllMenus();
  if (silent && state.selectedThread?.id === threadId) {
    await refreshSelectedThread({ preserveScroll });
    return;
  }
  const switchingThreads = state.selectedThread?.id && state.selectedThread.id !== threadId;
  if (!silent && switchingThreads && state.uploadRequest) {
    showToast("请等待当前文件上传完成，或先取消上传");
    return;
  }
  if (!silent && switchingThreads && state.pendingFiles.length) {
    showToast("请先发送或移除当前任务中待上传的文件");
    return;
  }
  const sequence = ++state.openThreadSequence;
  const loadingToken = silent ? null : showLoadingToast("正在加载任务…");
  if (!silent) elements.chatTitle.textContent = "正在载入…";
  try {
    const params = new URLSearchParams();
    if (!archived) params.set("subscribe", "true");
    const suffix = params.size ? `?${params}` : "";
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}${suffix}`);
    if (sequence !== state.openThreadSequence) return;
    const summary = state.threads.find((thread) => thread.id === threadId) || {};
    applyThreadOwnership(threadId, result);
    renderThread(
      { ...summary, ...result.thread, archived },
      result.history,
      {
        activeTurnId: result.activeTurnId,
        activeTranscript: result.activeTranscript,
        settings: result.settings,
        goal: result.goal,
        goalSupported: result.goalSupported,
        preserveScroll,
      },
    );
    if (result.activeTranscriptAvailable && result.activeTurnId) {
      await restoreActiveTranscript(threadId, result.activeTurnId, { force: true, follow: !preserveScroll });
    }
    if (result.goalSupported === undefined) await loadThreadGoal(threadId);
    await loadThreadArtifacts(threadId).catch(() => {});
    if (sequence !== state.openThreadSequence || state.selectedThread?.id !== threadId) return;
    if (result.subscriptionError) showToast(`实时订阅失败，已保留只读历史：${result.subscriptionError}`);
    if (updateRoute) updateThreadRoute(threadId, { archived });
    closeSidebar();
  } catch (error) {
    if (sequence !== state.openThreadSequence) return;
    showToast(error.message);
    if (state.selectedThread) updateChatHeader();
    else {
      elements.chatTitle.textContent = "Codex Remote";
      elements.chatMeta.textContent = "点击左侧主菜单查看历史会话";
    }
  } finally {
    if (loadingToken) finishLoadingToast(loadingToken);
  }
}

async function loadOlderTurns() {
  if (!state.selectedThread || !state.historyCursor || state.historyLoading) return;
  const threadId = state.selectedThread.id;
  const cursor = state.historyCursor;
  const previousHeight = elements.messages.scrollHeight;
  const previousTop = elements.messages.scrollTop;
  state.historyLoading = true;
  const loadingToken = showLoadingToast("正在加载更多历史对话…");
  updateHistoryControls();
  try {
    const params = new URLSearchParams({ cursor, items: "full" });
    const page = await api(`/api/threads/${encodeURIComponent(threadId)}/turns?${params}`);
    if (state.selectedThread?.id !== threadId) return;
    if (!canRetainHistoryPage(page.data || [])) {
      markHistoryMemoryLimited();
      return;
    }
    if (state.historyWindow.enabled) {
      const windowStart = state.historyWindow.start;
      mergeTurnsPage(page.data || [], { prepend: true, deferRender: true });
      renderHistoryWindow({ start: windowStart, scroll: "preserve" });
    } else {
      renderTurnsPage(page.data || [], { prepend: true });
    }
    renderKnownArtifacts();
    renderChangesPanel();
    state.historyCursor = page.nextCursor || null;
    if (state.historyCompleteStarted) state.historyCompleteCursor = state.historyCursor;
    if (state.historyCompleteStarted && !state.historyCursor) state.historyComplete = true;
    requestAnimationFrame(() => {
      const addedHeight = elements.messages.scrollHeight - previousHeight;
      elements.messages.scrollTop = previousTop + addedHeight;
    });
  } catch (error) {
    showToast(`加载历史失败：${error.message}`);
  } finally {
    finishLoadingToast(loadingToken);
    if (state.selectedThread?.id === threadId) {
      state.historyLoading = false;
      updateHistoryControls();
    }
  }
}

async function loadActivityDetails() {
  if (!state.selectedThread || state.activityDetailsLoaded || state.activityDetailsLoading) return;
  const threadId = state.selectedThread.id;
  const wasFollowing = shouldFollowOutput();
  state.activityDetailsLoading = true;
  const loadingToken = showLoadingToast("正在加载历史活动…");
  updateHistoryControls();
  try {
    const params = new URLSearchParams({ items: "full", limit: "6" });
    const page = await api(`/api/threads/${encodeURIComponent(threadId)}/turns?${params}`);
    if (state.selectedThread?.id !== threadId) return;
    if (!canRetainHistoryPage(page.data || [])) {
      markHistoryMemoryLimited();
      return;
    }
    mergeTurnsPage(page.data || [], { replaceItems: true });
    state.activityDetailsLoaded = true;
    renderChangesPanel();
    if (wasFollowing) requestAnimationFrame(() => scrollToBottom(true));
  } catch (error) {
    showToast(`加载历史对话失败：${error.message}`, 5200);
  } finally {
    finishLoadingToast(loadingToken);
    if (state.selectedThread?.id === threadId) {
      state.activityDetailsLoading = false;
      updateHistoryControls();
    }
  }
}

async function loadMoreHistory() {
  if (state.historyContext.active) {
    const direction = state.historyContext.newerCursor ? "newer" : "older";
    if (!state.historyContext.newerCursor && !state.historyContext.olderCursor) {
      showToast("已载入所选节点的全部上下文", 2600);
      return;
    }
    await loadHistoryContextPage(direction);
    return;
  }
  if (!state.selectedThread || state.historyMemoryLimited || state.historyLoading || state.activityDetailsLoading) return;
  if (!state.activityDetailsLoaded) {
    await loadActivityDetails();
    return;
  }
  if (state.historyCursor) {
    await loadOlderTurns();
    return;
  }
  showToast("已加载全部可用活动", 2600);
}

async function loadCompleteHistory() {
  if (state.historyContext.active) {
    await loadCompleteHistoryContext();
    return;
  }
  if (!state.selectedThread || state.historyMemoryLimited || state.historyComplete || state.historyCompleteLoading) return;
  const threadId = state.selectedThread.id;
  const wasFollowing = shouldFollowOutput();
  state.historyCompleteLoading = true;
  state.historyComplete = false;
  const loadingToken = showLoadingToast("正在加载完整历史对话…");
  elements.messages.classList.add("full-history");
  updateHistoryControls();
  let cursor = state.historyCompleteStarted ? state.historyCompleteCursor : null;
  let firstPage = !state.historyCompleteStarted;
  let pages = 0;
  let added = 0;
  try {
    do {
      // Load every turn, but keep each turn's heavy command/tool activity in
      // the server's bounded mobile representation instead of transferring
      // unbounded raw outputs into browser memory.
      const params = new URLSearchParams({ items: "full", limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const page = await api(`/api/threads/${encodeURIComponent(threadId)}/turns?${params}`);
      if (state.selectedThread?.id !== threadId) return;
      if (!canRetainHistoryPage(page.data || [])) {
        markHistoryMemoryLimited();
        break;
      }
      added += mergeTurnsPage(page.data || [], {
        replaceItems: true,
        prepend: !firstPage,
        complete: firstPage,
        deferRender: true,
      });
      state.activityDetailsLoaded = true;
      state.historyCompleteStarted = true;
      firstPage = false;
      pages += 1;
      cursor = page.nextCursor || null;
      state.historyCompleteCursor = cursor;
      state.historyCursor = cursor;
      state.historyComplete = !cursor;
      updateHistoryControls();
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    } while (cursor && pages < 25);
    renderHistoryWindow({
      start: Math.max(0, (state.selectedThread?.turns?.length || 0) - state.historyWindow.size),
      scroll: wasFollowing ? "bottom" : "preserve",
    });
    renderChangesPanel();
    if (state.historyMemoryLimited) {
      // markHistoryMemoryLimited() already explains how to recover.
    } else if (cursor) {
      showToast(`本次新增 ${added.toLocaleString("zh-CN")} 个历史轮次；再次点击可从当前位置继续`, 5200);
    } else {
      showToast("已加载完整历史对话", 2600);
    }
  } catch (error) {
    showToast(`加载完整活动失败：${error.message}`, 5200);
  } finally {
    finishLoadingToast(loadingToken);
    if (state.selectedThread?.id === threadId) {
      state.historyCompleteLoading = false;
      updateHistoryControls();
    }
  }
}

function resetHistoryNodes(threadId = null) {
  if (state.historyNodes?.renderFrame) cancelAnimationFrame(state.historyNodes.renderFrame);
  elements.historyNodesLoading?.classList.add("hidden");
  elements.historyNodesList?.classList.remove("focus-loading");
  if (elements.historyNodesSearch) elements.historyNodesSearch.disabled = false;
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
    || input)
    .trim();
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
    if (!Number.isFinite(value) || value <= 0) continue;
    return value > 1e12 ? value / 1000 : value;
  }
  return 0;
}

function appendHistoryNodes(turns, { pageCursor = null } = {}) {
  const nodes = state.historyNodes;
  const known = new Set(nodes.data.map((node) => node.id));
  for (const turn of turns || []) {
    if (nodes.data.length >= MAX_RETAINED_HISTORY_NODES) return true;
    if (!turn?.id || known.has(turn.id)) continue;
    const text = historyNodePrompt(turn).slice(0, MAX_HISTORY_NODE_TEXT_CHARS);
    if (!text) continue;
    nodes.data.push({
      id: turn.id,
      turn,
      text,
      preview: historyNodePreview(text),
      timestamp: turnTimestamp(turn),
      pageCursor,
    });
    known.add(turn.id);
  }
  return false;
}

const HISTORY_NODE_ROW_HEIGHT = 74;

function renderHistoryNodes() {
  const nodes = state.historyNodes;
  const query = elements.historyNodesSearch.value.trim().toLocaleLowerCase("zh-CN");
  const visible = query
    ? nodes.data.filter((node) => `${node.text}\n${node.id}`.toLocaleLowerCase("zh-CN").includes(query))
    : nodes.data;
  elements.historyNodesStatus.textContent = nodes.data.length
    ? `${visible.length}/${nodes.data.length} 个节点${nodes.memoryLimited ? " · 已达缓存上限" : nodes.complete ? " · 已全部载入" : ""}`
    : "";
  const initialLoading = !query && nodes.data.length === 0 && (nodes.loading || nodes.loadingAll);
  if (!visible.length) {
    const empty = el("div", "history-nodes-empty");
    if (initialLoading) {
      empty.classList.add("history-nodes-loading");
      empty.append(el("span", "spinner"), el("strong", "", "加载中……"));
    } else if (!query && nodes.error) {
      empty.classList.add("history-nodes-error");
      empty.append(
        el("strong", "", "历史节点加载失败"),
        el("span", "", `${nodes.error}。请点击下方按钮重试。`),
      );
    } else {
      empty.append(
        el("strong", "", query ? "没有匹配的历史节点" : "还没有可显示的历史节点"),
        el("span", "", query ? "换一个关键词试试。" : "发送第一条消息后，这里会按轮次整理 Prompt。"),
      );
    }
    elements.historyNodesList.setAttribute("aria-busy", String(initialLoading || nodes.focusLoading));
    elements.historyNodesCanvas.classList.add("empty");
    elements.historyNodesCanvas.style.height = "100%";
    elements.historyNodesRows.style.transform = "";
    elements.historyNodesRows.replaceChildren(empty);
    nodes.rangeStart = -1;
    nodes.rangeEnd = -1;
    return;
  }
  elements.historyNodesList.setAttribute("aria-busy", String(nodes.focusLoading));
  elements.historyNodesCanvas.classList.remove("empty");
  elements.historyNodesCanvas.style.height = `${visible.length * HISTORY_NODE_ROW_HEIGHT}px`;
  const overscan = 12;
  const { start, end } = fixedVirtualRange({
    total: visible.length,
    scrollTop: elements.historyNodesList.scrollTop,
    rowHeight: HISTORY_NODE_ROW_HEIGHT,
    viewportHeight: elements.historyNodesList.clientHeight || 464,
    overscan,
  });
  if (start === nodes.rangeStart && end === nodes.rangeEnd) return;
  nodes.rangeStart = start;
  nodes.rangeEnd = end;
  const fragment = document.createDocumentFragment();
  visible.slice(start, end).forEach((node, offset) => {
    const index = start + offset;
    const button = el("button", "history-node");
    button.type = "button";
    button.title = node.text;
    const ordinal = el("span", "history-node-index", `#${index + 1}`);
    const copy = el("span", "history-node-copy");
    copy.append(
      el("span", "history-node-preview", node.preview),
      el("span", "history-node-meta", node.id),
      el("span", "history-node-time", node.timestamp ? formatAbsolute(node.timestamp) : "—"),
    );
    button.dataset.historyNodeIndex = String(index);
    button.append(ordinal, copy);
    button.addEventListener("click", () => focusHistoryNode(node));
    fragment.append(button);
  });
  elements.historyNodesRows.style.transform = `translate3d(0, ${start * HISTORY_NODE_ROW_HEIGHT}px, 0)`;
  elements.historyNodesRows.replaceChildren(fragment);
}

function setHistoryNodesFocusLoading(loading, message = "正在定位并加载节点上下文…") {
  const nodes = state.historyNodes;
  nodes.focusLoading = Boolean(loading);
  elements.historyNodesLoading.classList.toggle("hidden", !nodes.focusLoading);
  const messageNode = elements.historyNodesLoading.querySelector(".history-nodes-loading-message");
  if (messageNode) messageNode.textContent = message;
  elements.historyNodesList.classList.toggle("focus-loading", nodes.focusLoading);
  elements.historyNodesSearch.disabled = nodes.focusLoading;
  elements.historyNodesList.setAttribute("aria-busy", String(nodes.focusLoading || nodes.loading || nodes.loadingAll));
  updateHistoryNodesControls();
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
  const loadingToken = showLoadingToast(all ? "正在加载全部历史对话节点…" : "正在加载历史对话节点…");
  updateHistoryNodesControls();
  renderHistoryNodes();
  let cursor = nodes.nextCursor;
  let pages = 0;
  try {
    do {
      const params = new URLSearchParams({ limit: all ? "50" : "30" });
      if (cursor) params.set("cursor", cursor);
      const page = await api(`/api/threads/${encodeURIComponent(threadId)}/turns?${params}`);
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
    if (nodes.memoryLimited) showToast("已达到 5,000 个历史节点的手机缓存上限", 5200);
    else if (all && cursor) showToast("本次已载入最多 2,500 个历史节点；再次点击可继续", 5200);
  } catch (error) {
    nodes.error = error.message || "无法读取历史节点";
    showToast(`历史节点加载失败：${error.message}`, 5200);
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
  elements.historyNodesLoadMoreButton.textContent = nodes.focusLoading
    ? "正在定位…"
    : nodes.loading && !nodes.loadingAll
    ? "正在加载…"
    : nodes.memoryLimited ? "已达缓存上限" : canRetryInitialLoad ? "重新加载" : "加载更早节点";
  elements.historyNodesLoadAllButton.disabled = loading || nodes.memoryLimited || nodes.complete || !nodes.nextCursor;
  elements.historyNodesLoadAllButton.textContent = nodes.focusLoading
    ? "正在定位…"
    : nodes.loadingAll
    ? "正在载入全部…"
    : nodes.memoryLimited ? "已达缓存上限" : nodes.complete ? "已全部载入" : "加载全部节点";
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
  if (!state.historyNodes.data.length && !state.historyNodes.complete) {
    await loadHistoryNodesPage();
  } else {
    renderHistoryNodes();
    updateHistoryNodesControls();
  }
}

function historyCollectionFits(turns) {
  if (turns.length > MAX_RETAINED_HISTORY_TURNS) return false;
  let retainedChars = 0;
  for (const turn of turns) {
    retainedChars += JSON.stringify(turn).length;
    if (retainedChars > MAX_RETAINED_HISTORY_CHARS) return false;
  }
  return true;
}

function replaceHistoryContextTurns(turns, node, page) {
  clearStreamingRenderTimers();
  state.itemNodes.clear();
  state.itemTurns.clear();
  state.itemText.clear();
  state.pendingUserMessages.length = 0;
  state.loadedTurnIds.clear();
  state.fileChanges.clear();
  collectTurnFileChanges(turns);
  state.selectedThread.turns = turns;
  syncHistoryRetention(turns);
  state.historyMemoryLimited = false;
  state.historyWindow = { enabled: false, start: 0, end: 0, size: 160 };
  state.activityDetailsLoaded = true;
  state.activityDetailsLoading = false;
  state.historyCursor = null;
  state.historyCompleteStarted = true;
  state.historyCompleteCursor = null;
  state.historyCompleteLoading = false;
  state.historyContext = {
    active: true,
    threadId: state.selectedThread.id,
    targetTurnId: node.id,
    olderCursor: page.nextCursor || null,
    newerCursor: node.pageCursor ? page.backwardsCursor || null : null,
    loadingDirection: null,
    deferredUpdates: false,
    sequence: state.historyContext.sequence,
  };
  state.historyComplete = !state.historyContext.olderCursor && !state.historyContext.newerCursor;
  elements.messages.classList.add("full-history", "history-context");
  renderChangesPanel();
  const targetIndex = turns.findIndex((turn) => turn.id === node.id);
  renderHistoryWindow({
    start: Math.max(0, targetIndex - Math.floor(state.historyWindow.size / 3)),
    focusTurnId: node.id,
  });
  const group = turnGroup(node.id);
  group?.classList.add("history-node-target");
  if (group) setTimeout(() => group.classList.remove("history-node-target"), 1800);
}

function mergeHistoryContextTurns(incoming, direction) {
  const current = state.selectedThread?.turns || [];
  const incomingById = new Map(incoming.map((turn) => [turn.id, turn]));
  if (direction === "older") {
    return [...incoming, ...current.filter((turn) => !incomingById.has(turn.id))];
  }
  const currentIds = new Set(current.map((turn) => turn.id));
  return [
    ...current.map((turn) => incomingById.get(turn.id) || turn),
    ...incoming.filter((turn) => !currentIds.has(turn.id)),
  ];
}

async function loadHistoryContextPage(direction, { render = true } = {}) {
  const context = state.historyContext;
  const threadId = state.selectedThread?.id;
  if (!context.active || context.threadId !== threadId || context.loadingDirection) return false;
  const cursor = direction === "older" ? context.olderCursor : context.newerCursor;
  if (!cursor) return false;
  const sequence = context.sequence;
  context.loadingDirection = direction;
  const loadingToken = state.historyCompleteLoading
    ? null
    : showLoadingToast(direction === "newer" ? "正在加载较新的历史对话…" : "正在加载更早的历史对话…");
  updateHistoryControls();
  if (render) renderHistoryWindow({ focusTurnId: context.targetTurnId });
  try {
    const params = new URLSearchParams({
      cursor,
      items: "full",
      limit: String(HISTORY_CONTEXT_PAGE_SIZE),
      sort: direction === "newer" ? "asc" : "desc",
    });
    const page = await api(`/api/threads/${encodeURIComponent(threadId)}/turns?${params}`);
    if (state.selectedThread?.id !== threadId || !state.historyContext.active || state.historyContext.sequence !== sequence) return false;
    const incoming = chronologicalTurns(page.data || [], page.sortDirection || (direction === "newer" ? "asc" : "desc"));
    const currentIds = new Set((state.selectedThread?.turns || []).map((turn) => turn.id));
    const addedTurns = incoming.filter((turn) => !currentIds.has(turn.id));
    const merged = mergeHistoryContextTurns(incoming, direction);
    if (!historyCollectionFits(merged)) {
      markHistoryMemoryLimited();
      return false;
    }
    state.selectedThread.turns = merged;
    syncHistoryRetention(merged);
    collectTurnFileChanges(incoming, { older: direction === "older" });
    if (direction === "older") context.olderCursor = page.nextCursor || null;
    else context.newerCursor = page.nextCursor || null;
    state.historyComplete = !context.olderCursor && !context.newerCursor;
    if (render) {
      const focusTurnId = direction === "older"
        ? addedTurns.at(-1)?.id
        : addedTurns[0]?.id;
      const focusIndex = merged.findIndex((turn) => turn.id === (focusTurnId || context.targetTurnId));
      renderHistoryWindow({ start: Math.max(0, focusIndex - 2), focusTurnId: focusTurnId || context.targetTurnId });
    }
    return true;
  } catch (error) {
    showToast(`上下文加载失败：${error.message}`, 5200);
    return false;
  } finally {
    if (loadingToken) finishLoadingToast(loadingToken);
    if (state.historyContext.sequence === sequence) {
      state.historyContext.loadingDirection = null;
      updateHistoryControls();
    }
  }
}

async function loadCompleteHistoryContext() {
  const context = state.historyContext;
  if (!context.active || state.historyCompleteLoading || state.historyMemoryLimited) return;
  const threadId = context.threadId;
  const sequence = context.sequence;
  state.historyCompleteLoading = true;
  const loadingToken = showLoadingToast("正在加载完整历史上下文…");
  updateHistoryControls();
  let pages = 0;
  try {
    while ((context.newerCursor || context.olderCursor) && pages < 25) {
      const direction = context.newerCursor ? "newer" : "older";
      const loaded = await loadHistoryContextPage(direction, { render: false });
      if (!loaded || state.selectedThread?.id !== threadId || state.historyContext.sequence !== sequence) break;
      pages += 1;
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    }
    if (state.selectedThread?.id !== threadId || state.historyContext.sequence !== sequence) return;
    const targetIndex = state.selectedThread.turns.findIndex((turn) => turn.id === context.targetTurnId);
    renderHistoryWindow({ start: Math.max(0, targetIndex - Math.floor(state.historyWindow.size / 3)), focusTurnId: context.targetTurnId });
    if (context.newerCursor || context.olderCursor) {
      showToast("本次最多载入 500 个轮次；再次点击可继续", 5200);
    } else {
      showToast("已加载完整历史对话", 2600);
    }
  } finally {
    finishLoadingToast(loadingToken);
    if (state.historyContext.sequence === sequence) {
      state.historyCompleteLoading = false;
      updateHistoryControls();
    }
  }
}

async function returnToLatestConversation() {
  const threadId = state.selectedThread?.id;
  if (!threadId) return false;
  await openThread(threadId, {
    preserveScroll: false,
    updateRoute: false,
    archived: Boolean(state.selectedThread.archived),
  });
  return state.selectedThread?.id === threadId && !state.historyContext.active;
}

async function focusHistoryNode(node) {
  if (!node?.id || state.selectedThread?.id !== state.historyNodes.threadId) return;
  if (state.historyContext.loadingDirection) return;
  const threadId = state.selectedThread.id;
  const sequence = state.historyContext.sequence + 1;
  state.historyContext.sequence = sequence;
  state.historyContext.loadingDirection = "focus";
  setHistoryNodesFocusLoading(true);
  const loadingToken = showLoadingToast("正在定位并加载节点上下文…");
  try {
    const params = new URLSearchParams({
      items: "full",
      limit: String(HISTORY_CONTEXT_PAGE_SIZE),
    });
    if (node.pageCursor) params.set("cursor", node.pageCursor);
    const page = await api(`/api/threads/${encodeURIComponent(threadId)}/turns?${params}`);
    if (state.selectedThread?.id !== threadId || state.historyContext.sequence !== sequence) return;
    if (!elements.historyNodesDialog.open) return;
    const turns = chronologicalTurns(page.data || [], page.sortDirection || "desc");
    if (!turns.some((turn) => turn.id === node.id)) throw new Error("节点位置已经变化，请重新打开历史节点列表后再试");
    if (!historyCollectionFits(turns)) throw new Error("所选节点附近的内容超过手机缓存上限");
    elements.historyNodesDialog.close();
    replaceHistoryContextTurns(turns, node, page);
    showHistoryContextFeedback("已定位到所选历史节点", 2600);
  } catch (error) {
    showToast(`历史节点定位失败：${error.message}`, 5200);
  } finally {
    finishLoadingToast(loadingToken);
    if (state.historyNodes.threadId === threadId) setHistoryNodesFocusLoading(false);
    if (!state.historyContext.active && state.historyContext.sequence === sequence) {
      state.historyContext.loadingDirection = null;
    }
  }
}

function updateChatHeader() {
  if (!state.selectedThread) return;
  elements.chatTitle.textContent = threadTitle(state.selectedThread);
  const parts = [basename(state.selectedThread.cwd)];
  if (state.selectedThread.gitInfo?.branch) parts.push(state.selectedThread.gitInfo.branch);
  parts.push(statusInfo(state.selectedThread.status).label);
  elements.chatMeta.textContent = parts.filter(Boolean).join(" · ");
}

function updateChatActions() {
  const hasThread = Boolean(state.selectedThread);
  elements.chatMenu.classList.toggle("hidden", !hasThread);
  elements.contextButton.classList.toggle("hidden", !hasThread);
  if (!hasThread) return;
  const threadId = state.selectedThread.id;
  const running = Boolean(state.activeTurnId);
  const owned = state.ownedThreads.has(threadId);
  const releasing = state.releasingThreads.has(threadId);
  elements.pinThreadButton.textContent = state.pinned.has(state.selectedThread.id) ? "取消置顶" : "置顶";
  elements.archiveThreadButton.textContent = state.selectedThread.archived ? "恢复" : "归档";
  elements.goalThreadButton.textContent = state.goal ? "编辑 Goal" : "创建 Goal";
  elements.releaseThreadButton.disabled = running || releasing || !owned;
  elements.releaseThreadButton.textContent = running
    ? "任务运行中，保持实时跟进"
    : releasing
      ? "正在停止实时跟进…"
      : owned
        ? "停止实时跟进"
        : "当前未实时跟进";
}

function updateTurnControls() {
  const running = Boolean(state.activeTurnId);
  elements.stopButton.classList.toggle("hidden", !running);
  elements.sendButton.classList.toggle("running", running);
  elements.promptInput.placeholder = running ? "补充指令，将追加到当前运行中的任务…" : "继续告诉 Codex 要做什么…";
  const threadId = state.selectedThread?.id;
  const releasing = threadId && state.releasingThreads.has(threadId);
  const owned = threadId && state.ownedThreads.has(threadId);
  const pending = hasPendingSettings(threadId);
  elements.composerHint.textContent = running
    ? pending
      ? "任务正在运行；发送内容会追加到当前轮次，待应用设置会保留到下一轮。"
      : "任务正在运行；发送内容会实时追加到当前轮次。"
    : releasing
      ? "正在停止手机端的实时事件跟进。"
      : owned
        ? pending
          ? "待应用设置会在下一条新消息成功启动后生效。"
          : "手机端正在实时跟进；Windows 可同时查看，空闲一段时间后会自动停止跟进。"
        : "当前只显示已同步内容；发送消息或重新打开时会恢复实时跟进。";
}

const goalStatusLabels = {
  active: "进行中",
  paused: "已暂停",
  blocked: "已阻塞",
  usageLimited: "达到用量限制",
  budgetLimited: "达到预算上限",
  complete: "已完成",
};

function goalStatusLabel(status) {
  return goalStatusLabels[status] || status || "未知状态";
}

function formatGoalDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = Math.floor(total % 60);
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes) return `${minutes} 分钟 ${remaining} 秒`;
  return `${remaining} 秒`;
}

function formatGoalTokens(value) {
  return Number(value || 0).toLocaleString("zh-CN");
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
  const objective = el("span", "goal-objective", goal.objective || "未填写目标");
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
  const edit = el("button", "", "编辑 Goal");
  edit.type = "button";
  edit.disabled = pending;
  edit.addEventListener("click", () => openGoalDialog({ thread: state.selectedThread, goal }));
  actions.append(edit);
  if (status === "active") {
    const pause = el("button", "", "暂停目标");
    pause.type = "button";
    pause.disabled = pending;
    pause.addEventListener("click", () => setGoalStatus("paused"));
    actions.append(pause);
  } else if (status && status !== "complete") {
    const resume = el("button", "", "继续目标");
    resume.type = "button";
    resume.disabled = pending;
    resume.addEventListener("click", () => setGoalStatus("active"));
    actions.append(resume);
  }
  if (status && status !== "complete") {
    const finish = el("button", "danger", "结束目标");
    finish.type = "button";
    finish.disabled = pending;
    finish.addEventListener("click", () => setGoalStatus("complete"));
    actions.append(finish);
  }
  const clear = el("button", "danger", "清除目标");
  clear.type = "button";
  clear.disabled = pending;
  clear.addEventListener("click", clearGoal);
  actions.append(clear);
  bar.append(mark, copy, actions);
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
    active: {
      eyebrow: "RESUME GOAL",
      title: "继续这个 Goal？",
      message: `${state.goal.objective}\n\n继续后，后续新消息会沿用这个长期目标。`,
      confirmLabel: "继续目标",
    },
    paused: {
      eyebrow: "PAUSE GOAL",
      title: "暂停这个 Goal？",
      message: `${state.goal.objective}\n\n暂停只会改变目标状态，不会删除会话、消息或项目文件。`,
      confirmLabel: "暂停目标",
    },
    complete: {
      eyebrow: "COMPLETE GOAL",
      title: "结束这个 Goal？",
      message: `${state.goal.objective}\n\n结束后目标会标记为“已完成”，不会删除会话或文件。`,
      confirmLabel: "结束目标",
      danger: true,
    },
  };
  const action = goalActions[status];
  if (action) {
    const confirmed = await requestConfirmation(action);
    if (!confirmed) return;
  }
  state.goalActionPending = true;
  const loadingToken = showLoadingToast("正在更新 Goal…");
  renderGoalBar();
  try {
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}/goal`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
    applyGoalState(threadId, result);
    showToast(status === "active" ? "Goal 已继续" : status === "paused" ? "Goal 已暂停" : "Goal 已结束");
  } catch (error) {
    showToast(`Goal 状态更新失败：${error.message}`, 5200);
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
    eyebrow: "CLEAR GOAL",
    title: "清除这个 Goal？",
    message: `${state.goal.objective}\n\n只会清除目标状态，不会删除会话、消息或项目文件。`,
    confirmLabel: "清除目标",
    danger: true,
  });
  if (!confirmed) return;
  state.goalActionPending = true;
  const loadingToken = showLoadingToast("正在清除 Goal…");
  renderGoalBar();
  try {
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}/goal`, { method: "DELETE", body: "{}" });
    applyGoalState(threadId, result);
    showToast("Goal 已清除");
  } catch (error) {
    showToast(`清除 Goal 失败：${error.message}`, 5200);
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
  elements.goalDialogTitle.textContent = goal ? "编辑 Goal" : "创建 Goal";
  elements.goalObjectiveInput.value = goal?.objective || "";
  elements.goalBudgetInput.value = goal?.tokenBudget == null ? "" : String(goal.tokenBudget);
  elements.goalStatusInput.value = goal?.status || "active";
  elements.goalDialogHint.textContent = goal
    ? "保存只更新 Goal，不会自动发送新的消息。"
    : "创建后会绑定到当前任务，不会自动发送新的消息。";
  elements.goalDialog.showModal();
  setTimeout(() => elements.goalObjectiveInput.focus(), 40);
}

async function saveGoal(event) {
  event.preventDefault();
  const threadId = state.goalEditThreadId || state.selectedThread?.id;
  if (!threadId) return;
  const objective = elements.goalObjectiveInput.value.trim();
  if (!objective) {
    showToast("请填写 Goal 目标描述");
    elements.goalObjectiveInput.focus();
    return;
  }
  const budgetText = elements.goalBudgetInput.value.trim();
  const tokenBudget = budgetText === "" ? null : Number(budgetText);
  if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0)) {
    showToast("Token 预算必须是非负整数");
    return;
  }
  const confirmed = await requestConfirmation({
    eyebrow: state.goal ? "UPDATE GOAL" : "CREATE GOAL",
    title: state.goal ? "确认保存 Goal 修改？" : "确认创建这个 Goal？",
    message: `${confirmationPreview(objective, 1_200)}\n\n${tokenBudget === null ? "不限制 Token 预算。" : `Token 预算：${tokenBudget.toLocaleString("zh-CN")}`}`,
    confirmLabel: state.goal ? "确认保存" : "确认创建",
  });
  if (!confirmed) return;
  const submit = elements.goalForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  const previousSubmitLabel = submit.textContent;
  const loadingToken = showLoadingToast("正在保存 Goal…");
  submit.textContent = "正在保存…";
  try {
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}/goal`, {
      method: "POST",
      body: JSON.stringify({ objective, tokenBudget, status: elements.goalStatusInput.value }),
    });
    applyGoalState(threadId, result);
    elements.goalDialog.close();
    showToast(result.goal ? "Goal 已保存" : "Goal 已更新");
  } catch (error) {
    showToast(`Goal 保存失败：${error.message}`, 5200);
  } finally {
    finishLoadingToast(loadingToken);
    submit.disabled = false;
    submit.textContent = previousSubmitLabel;
  }
}

async function stopLiveFollowing() {
  if (!state.selectedThread) return;
  if (state.activeTurnId) {
    showToast("请等待当前回复完成后再停止实时跟进");
    return;
  }
  const threadId = state.selectedThread.id;
  state.releasingThreads.add(threadId);
  updateChatActions();
  updateTurnControls();
  try {
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}/release`, {
      method: "POST", body: "{}",
    });
    state.ownedThreads.delete(threadId);
    if (result.status === "deferred" || result.status === "releasing") state.releasingThreads.add(threadId);
    else state.releasingThreads.delete(threadId);
    updateChatActions();
    updateTurnControls();
    showToast(
      result.status === "deferred" || result.status === "releasing"
        ? "操作已排队；当前任务结束后会停止实时跟进"
        : result.status === "notOwned"
          ? "手机当前没有实时跟进这个任务"
          : "已停止实时跟进；Windows 和手机仍可随时重新打开",
    );
  } catch (error) {
    state.releasingThreads.delete(threadId);
    updateChatActions();
    updateTurnControls();
    showToast(error.message);
  }
}

function renderChangesPanel() {
  elements.changesPanel.replaceChildren();
  const changes = [...state.fileChanges.values()];
  const count = changes.length;
  elements.changeCountBadge.textContent = String(count);
  elements.changeCountBadge.classList.toggle("hidden", count === 0);
  if (!count && !state.rawDiff) {
    const empty = el("div", "context-empty");
    empty.append(el("strong", "", "还没有文件变更"), el("p", "", "Codex 修改文件后，这里会显示按文件整理的差异。"));
    elements.changesPanel.append(empty);
    return;
  }
  for (const change of changes) {
    const details = el("details", "context-file");
    const summary = el("summary");
    summary.append(el("span", "file-kind", kindLabel(change.kind)), el("span", "context-file-name", change.path));
    details.append(summary);
    attachLazyDiff(details, change.diff);
    elements.changesPanel.append(details);
  }
  if (!changes.length && state.rawDiff) {
    const details = el("details", "context-file");
    details.open = true;
    const summary = el("summary");
    summary.append(el("span", "file-kind", "DIFF"), el("span", "context-file-name", "当前轮次差异"));
    details.append(summary);
    attachLazyDiff(details, state.rawDiff, { open: true });
    elements.changesPanel.append(details);
  }
}

function infoSection(title, rows) {
  const section = el("section", "info-section");
  section.append(el("h3", "", title));
  const grid = el("div", "info-grid");
  for (const [label, value] of rows) {
    const row = el("div", "info-row");
    row.append(el("span", "", label), el("span", "", value || "—"));
    grid.append(row);
  }
  section.append(grid);
  return section;
}

function renderInfoPanel() {
  elements.infoPanel.replaceChildren();
  const thread = state.selectedThread;
  if (!thread) return;
  const current = settingsState(thread.id);
  const effective = current.effective;
  const pending = current.pending;
  const effectiveModel = modelFor(effective.model);
  elements.infoPanel.append(
    infoSection("任务", [
      ["项目", basename(thread.cwd)], ["工作目录", thread.cwd], ["创建来源", sourceLabel(thread)],
      ["创建时间", formatAbsolute(thread.createdAt)], ["更新时间", formatAbsolute(thread.updatedAt)],
    ]),
    infoSection("Git", [
      ["分支", thread.gitInfo?.branch], ["提交", thread.gitInfo?.sha?.slice(0, 12)], ["远程", thread.gitInfo?.originUrl],
    ]),
    infoSection("会话", [
      ["任务 ID", thread.id], ["Codex", thread.cliVersion], ["状态", statusInfo(thread.status).label],
      ["当前模型", effectiveModel?.displayName || effective.model || "尚未读取"],
      ["推理强度", effective.effort ? effortLabel(effective.effort) : "模型默认"],
      ["访问权限", permissionLabels[effective.permissionPreset] || "尚未读取"],
    ]),
  );
  if (state.goalSupported !== false) {
    elements.infoPanel.append(infoSection("Goal", state.goal ? [
      ["状态", goalStatusLabel(state.goal.status)],
      ["目标", state.goal.objective],
      ["已用 token", `${formatGoalTokens(state.goal.tokensUsed)}${state.goal.tokenBudget ? ` / ${formatGoalTokens(state.goal.tokenBudget)}` : ""}`],
      ["已用时间", formatGoalDuration(state.goal.timeUsedSeconds)],
    ] : [["状态", "未设置"]]));
  }
  if (Object.keys(pending).length) {
    const next = displayedSettings(thread.id);
    elements.infoPanel.append(infoSection("待应用（下一轮）", [
      ["模型", modelFor(next.model)?.displayName || next.model || "保持当前"],
      ["推理强度", next.effort ? effortLabel(next.effort) : "模型默认"],
      ["访问权限", permissionLabels[next.permissionPreset] || "保持当前"],
    ]));
  }
  if (state.tokenUsage) {
    const usage = state.tokenUsage;
    elements.infoPanel.append(infoSection("上下文", [
      ["总输入", String(usage.total?.inputTokens ?? "—")], ["总输出", String(usage.total?.outputTokens ?? "—")],
      ["窗口", String(usage.modelContextWindow ?? "—")],
    ]));
  }
}

function toggleContext(force) {
  const open = force ?? !elements.contextPanel.classList.contains("open");
  if (open) closeAllMenus();
  elements.contextPanel.classList.toggle("open", open);
}

function setContextTab(tab) {
  const changes = tab === "changes";
  elements.changesTab.classList.toggle("active", changes);
  elements.infoTab.classList.toggle("active", !changes);
  elements.changesPanel.classList.toggle("hidden", !changes);
  elements.infoPanel.classList.toggle("hidden", changes);
}

function approvalDetail(approval) {
  const params = approval.params || {};
  if (typeof params.command === "string") return params.command;
  if (Array.isArray(params.command)) return params.command.join(" ");
  if (params.reason) return params.reason;
  if (params.changes) return JSON.stringify(params.changes, null, 2);
  return JSON.stringify(params, null, 2);
}

function isQuestionRequest(method) {
  return method === "item/tool/requestUserInput" || method === "tool/requestUserInput";
}

function renderApprovals() {
  elements.approvalArea.replaceChildren();
  for (const [requestId, approval] of state.approvals) {
    const threadId = approval.params?.threadId;
    if (state.selectedThread && threadId && threadId !== state.selectedThread.id) continue;
    if (isQuestionRequest(approval.method)) {
      renderQuestionRequest(requestId, approval);
      continue;
    }
    const card = el("section", "approval-card");
    const heading = el("div", "approval-heading");
    const isFile = approval.method.includes("fileChange") || approval.method === "applyPatchApproval";
    heading.append(el("strong", "", isFile ? "Codex 请求修改文件" : "Codex 请求执行操作"), el("span", "", "需要确认"));
    const detail = el("pre", "approval-detail", approvalDetail(approval));
    const actions = el("div", "approval-actions");
    for (const [label, decision, className] of [
      ["仅批准一次", "accept", "approve"], ["本次会话批准", "acceptForSession", "approve"],
      ["拒绝", "decline", "decline"], ["拒绝并停止", "cancel", "decline"],
    ]) {
      const button = el("button", className, label);
      button.type = "button";
      button.addEventListener("click", () => answerApproval(requestId, decision));
      actions.append(button);
    }
    card.append(heading, detail, actions);
    elements.approvalArea.append(card);
  }
}

function renderQuestionRequest(requestId, approval) {
  const card = el("form", "question-card");
  const heading = el("div", "approval-heading");
  heading.append(el("strong", "", "Codex 需要你的选择"), el("span", "", "等待回答"));
  card.append(heading);
  for (const question of approval.params?.questions || []) {
    const field = el("div", "question-field");
    field.dataset.questionId = question.id;
    field.append(el("span", "", question.question || question.header));
    if (question.options?.length) {
      const options = el("div", "question-options");
      for (const [index, option] of question.options.entries()) {
        const label = el("label", "question-option");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = `question-${requestId}-${question.id}`;
        input.value = option.label;
        if (index === 0) input.checked = true;
        const copy = el("span", "", option.label);
        if (option.description) copy.append(el("small", "", option.description));
        label.append(input, copy);
        options.append(label);
      }
      field.append(options);
    }
    if (!question.options?.length || question.isOther) {
      const input = document.createElement("input");
      input.type = question.isSecret ? "password" : "text";
      input.placeholder = question.isOther && question.options?.length ? "或者输入其他答案" : "输入回答";
      input.dataset.freeform = "true";
      field.append(input);
    }
    card.append(field);
  }
  const actions = el("div", "approval-actions");
  const submit = el("button", "approve", "提交回答");
  submit.type = "submit";
  actions.append(submit);
  card.append(actions);
  card.addEventListener("submit", (event) => answerQuestion(event, requestId));
  elements.approvalArea.append(card);
}

async function answerApproval(requestId, decision) {
  const approval = state.approvals.get(requestId);
  if (!approval) return;
  const labels = {
    accept: "仅批准一次",
    acceptForSession: "本次会话批准",
    decline: "拒绝",
    cancel: "拒绝并停止",
  };
  const label = labels[decision] || "提交决定";
  const confirmed = await requestConfirmation({
    eyebrow: "APPROVAL REQUEST",
    title: `确认${label}？`,
    message: `${confirmationPreview(approvalDetail(approval))}\n\n该决定会立即发送给 Codex，并可能执行命令或修改文件。`,
    confirmLabel: `确认${label}`,
    danger: decision === "accept" || decision === "acceptForSession" || decision === "cancel",
  });
  if (!confirmed || !state.approvals.has(requestId)) return;
  try {
    await api(`/api/approvals/${encodeURIComponent(requestId)}`, {
      method: "POST", body: JSON.stringify({ decision }),
    });
    if (state.approvals.delete(requestId)) state.approvalRevision += 1;
    renderApprovals();
  } catch (error) {
    showToast(error.message);
  }
}

async function answerQuestion(event, requestId) {
  event.preventDefault();
  const answers = {};
  const answerLines = [];
  for (const field of event.currentTarget.querySelectorAll(".question-field")) {
    const selected = field.querySelector('input[type="radio"]:checked');
    const freeform = field.querySelector('[data-freeform="true"]');
    const value = freeform?.value.trim() || selected?.value || "";
    if (!value) { showToast("请填写所有问题"); return; }
    answers[field.dataset.questionId] = { answers: [value] };
    answerLines.push(`${field.querySelector(":scope > span")?.textContent || field.dataset.questionId}：${value}`);
  }
  const confirmed = await requestConfirmation({
    eyebrow: "SUBMIT ANSWERS",
    title: "确认提交这些回答？",
    message: `${confirmationPreview(answerLines.join("\n"))}\n\n回答会继续影响当前任务的执行。`,
    confirmLabel: "确认提交",
  });
  if (!confirmed || !state.approvals.has(requestId)) return;
  try {
    await api(`/api/requests/${encodeURIComponent(requestId)}/respond`, {
      method: "POST", body: JSON.stringify({ answers }),
    });
    if (state.approvals.delete(requestId)) state.approvalRevision += 1;
    renderApprovals();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadStatus() {
  const sequence = ++state.statusLoadSequence;
  const approvalRevision = state.approvalRevision;
  const status = await api("/api/status");
  if (sequence !== state.statusLoadSequence || !state.auth.authenticated) return;
  state.roots = status.roots || [];
  state.appRoot = status.appRoot || "";
  state.version = status.version || "";
  state.ownedThreads = new Set(status.ownedThreads || []);
  state.releasingThreads = new Set(status.releasingThreads || []);
  elements.cwdInput.value ||= state.roots[0] || "";
  elements.instanceName.textContent = status.instanceName || "Linux Server";
  elements.networkLabel.textContent = status.networkLabel || "受控私有网络";
  setConnection(status.bridge, status.error);
  const pendingApprovals = new Map();
  for (const approval of status.pendingApprovals || []) {
    if (approval?.requestId) pendingApprovals.set(approval.requestId, approval);
  }
  if (approvalRevision === state.approvalRevision) state.approvals = pendingApprovals;
  // The global map only covers writers known to this bridge and can lag a
  // Windows-owned task. The selected thread's authoritative writer state is
  // reconciled by openThread()/refreshSelectedThread(), not by this snapshot.
  updateTurnControls();
  updateChatActions();
  renderApprovals();
}

const effortLabels = {
  low: "轻度（low）",
  medium: "中等（medium）",
  high: "高（high）",
  xhigh: "极高（xhigh）",
  max: "最大（max）",
  ultra: "极致（ultra，自动委派）",
};

const permissionLabels = {
  request: "请求批准",
  auto: "帮我批准",
  full: "完全批准",
  custom: "自定义（保持原设置）",
};

function effortLabel(value) {
  return effortLabels[value] || value || "模型默认";
}

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
  if (!state.threadSettings.has(threadId)) {
    state.threadSettings.set(threadId, { effective: {}, pending: {} });
  }
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

function populateModels() {
  for (const select of [elements.newModelSelect, elements.settingsModelSelect]) {
    const first = select.options[0];
    select.replaceChildren(first);
    for (const model of state.models) {
      const option = el("option", "", model.displayName || model.model || model.id);
      option.value = model.model || model.id;
      if (model.isDefault) option.textContent += "（默认）";
      select.append(option);
    }
  }
  ensureModelOption(elements.newModelSelect, state.newTaskModel);
  elements.newModelSelect.value = state.newTaskModel;
  syncEffortOptions(elements.newEffortSelect, state.newTaskModel, state.newTaskEffort);
  if (state.selectedThread) syncSettingsControls();
  updateOptionChips();
}

function syncEffortOptions(select, modelValue, selectedValue = "") {
  const first = select.options[0];
  select.replaceChildren(first);
  const model = modelFor(modelValue);
  const defaultEffort = model?.defaultReasoningEffort || "";
  first.textContent = defaultEffort ? `模型默认：${effortLabel(defaultEffort)}` : "模型默认";
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

async function loadModels() {
  try {
    const result = await api("/api/models");
    state.models = result.data || [];
    populateModels();
  } catch (error) {
    console.warn("Unable to load model catalog", error);
  }
}

function updateOptionChips() {
  const settings = displayedSettings();
  const model = modelFor(settings.model);
  const pending = hasPendingSettings();
  elements.modelChip.textContent = `${model?.displayName || settings.model || "当前模型"}${pending ? " · 待应用" : ""}`;
  elements.effortChip.textContent = settings.effort ? effortLabel(settings.effort) : "模型默认推理";
  elements.modelChip.classList.toggle("pending", pending);
  elements.effortChip.classList.toggle("pending", pending);
  renderInfoPanel();
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
    const option = el("option", "", permissionLabels.custom);
    option.value = "custom";
    elements.settingsPermissionSelect.prepend(option);
  }
  elements.settingsPermissionSelect.value = permission;
  const pending = hasPendingSettings();
  elements.settingsPendingHint.textContent = pending
    ? "这些改动尚未写入服务器；成功发送下一条新消息后才会生效。"
    : "当前显示的是此任务已生效的设置。只有修改并成功发送新消息后才会更新。";
}

function pathWithinDirectory(path, directory) {
  const normalizedPath = String(path || "").replace(/\/+$/, "") || "/";
  const normalizedDirectory = String(directory || "").replace(/\/+$/, "") || "/";
  return normalizedPath === normalizedDirectory
    || normalizedDirectory === "/"
    || normalizedPath.startsWith(`${normalizedDirectory}/`);
}

function renderDirectoryRoots() {
  elements.directoryRoots.replaceChildren();
  for (const root of state.directory.roots) {
    const button = el("button", "directory-root-button", root.name);
    button.type = "button";
    button.title = root.path;
    button.classList.toggle("active", pathWithinDirectory(state.directory.path, root.path));
    button.addEventListener("click", () => loadDirectory(root.path).catch((error) => showToast(error.message)));
    elements.directoryRoots.append(button);
  }
  elements.directoryRoots.classList.toggle("hidden", state.directory.roots.length < 2);
}

function renderDirectoryBreadcrumbs() {
  elements.directoryBreadcrumbs.replaceChildren();
  state.directory.breadcrumbs.forEach((crumb, index) => {
    if (index > 0) elements.directoryBreadcrumbs.append(el("span", "", "/"));
    const button = el("button", "", crumb.name);
    button.type = "button";
    button.title = crumb.path;
    button.disabled = crumb.path === state.directory.path;
    button.addEventListener("click", () => loadDirectory(crumb.path).catch((error) => showToast(error.message)));
    elements.directoryBreadcrumbs.append(button);
  });
  requestAnimationFrame(() => {
    elements.directoryBreadcrumbs.scrollLeft = elements.directoryBreadcrumbs.scrollWidth;
  });
}

function createDirectoryEntry({ name, path }, { parent = false } = {}) {
  const button = el("button", "directory-entry");
  button.type = "button";
  button.title = path;
  button.append(
    el("span", "directory-entry-icon", parent ? "↰" : "▰"),
    el("span", "directory-entry-name", parent ? "上一级" : name),
    el("span", "directory-entry-arrow", "›"),
  );
  button.addEventListener("click", () => loadDirectory(path).catch((error) => showToast(error.message)));
  return button;
}

function renderDirectoryList() {
  const query = elements.directorySearch.value.trim().toLocaleLowerCase("zh-CN");
  const entries = query
    ? state.directory.entries.filter((entry) => entry.name.toLocaleLowerCase("zh-CN").includes(query))
    : state.directory.entries;
  elements.directoryList.replaceChildren();

  if (!query && state.directory.parent) {
    elements.directoryList.append(createDirectoryEntry({
      name: "上一级",
      path: state.directory.parent,
    }, { parent: true }));
  }
  for (const entry of entries) elements.directoryList.append(createDirectoryEntry(entry));

  if (!elements.directoryList.children.length) {
    const empty = el("div", "directory-empty");
    empty.append(
      el("strong", "", query ? "没有匹配的文件夹" : "这里没有可显示的子目录"),
      el("span", "", query ? "换一个关键词试试。" : "可以选择当前目录，或在这里新建文件夹。"),
    );
    elements.directoryList.append(empty);
  }
  elements.directoryLimitNotice.classList.toggle("hidden", !state.directory.truncated);
}

function setDirectoryLoading(loading) {
  state.directory.loading = loading;
  elements.chooseDirectoryButton.disabled = loading || !state.directory.path;
  elements.showNewDirectoryButton.disabled = loading || !state.directory.path;
  elements.directorySearch.disabled = loading;
  elements.showHiddenDirectories.disabled = loading;
  if (!loading) return;
  const loadingRow = el("div", "directory-empty");
  loadingRow.append(el("span", "spinner"), el("span", "", "正在读取服务器目录…"));
  elements.directoryList.replaceChildren(loadingRow);
  elements.directoryLimitNotice.classList.add("hidden");
}

async function loadDirectory(path, { preserveSearch = false } = {}) {
  const sequence = ++state.directory.loadSequence;
  closeAllMenus();
  setDirectoryLoading(true);
  const loadingToken = showLoadingToast("正在读取服务器目录…");
  if (!preserveSearch) elements.directorySearch.value = "";
  try {
    const params = new URLSearchParams({
      path,
      hidden: String(elements.showHiddenDirectories.checked),
      query: elements.directorySearch.value.trim(),
    });
    const result = await api(`/api/directories?${params}`);
    if (sequence !== state.directory.loadSequence) return;
    Object.assign(state.directory, {
      path: result.path,
      parent: result.parent || null,
      roots: result.roots || [],
      breadcrumbs: result.breadcrumbs || [],
      entries: result.entries || [],
      truncated: Boolean(result.truncated),
    });
    elements.directoryCurrentPath.textContent = result.path;
    elements.directoryCurrentPath.title = result.path;
    renderDirectoryRoots();
    renderDirectoryBreadcrumbs();
    renderDirectoryList();
  } catch (error) {
    if (sequence === state.directory.loadSequence) {
      const failed = el("div", "directory-empty");
      failed.append(el("strong", "", "无法读取这个目录"), el("span", "", error.message));
      elements.directoryList.replaceChildren(failed);
    }
    throw error;
  } finally {
    finishLoadingToast(loadingToken);
    if (sequence === state.directory.loadSequence) setDirectoryLoading(false);
  }
}

function closeDirectoryBrowser() {
  elements.newDirectoryForm.classList.add("hidden");
  elements.newDirectoryInput.value = "";
  if (state.directorySelectionResolver) {
    const resolveSelection = state.directorySelectionResolver;
    state.directorySelectionResolver = null;
    resolveSelection(null);
  }
  if (elements.directoryDialog.open) elements.directoryDialog.close();
}

async function openDirectoryBrowser() {
  if (state.directorySelectionResolver) {
    state.directorySelectionResolver(null);
    state.directorySelectionResolver = null;
  }
  const fallback = state.roots[0] || "";
  const requested = elements.cwdInput.value.trim() || stored.lastDirectory || fallback;
  elements.directoryDialogTitle.textContent = "选择工作目录";
  closeAllMenus();
  elements.newDirectoryForm.classList.add("hidden");
  elements.newDirectoryInput.value = "";
  if (!elements.directoryDialog.open) elements.directoryDialog.showModal();
  try {
    await loadDirectory(requested);
  } catch (error) {
    if (requested === fallback) {
      showToast(error.message, 5200);
      return;
    }
    showToast("原工作目录不可浏览，已打开授权根目录", 4200);
    await loadDirectory(fallback).catch((fallbackError) => showToast(fallbackError.message, 5200));
  }
}

function chooseCurrentDirectory() {
  if (!state.directory.path || state.directory.loading) return;
  if (state.directorySelectionResolver) {
    const resolveSelection = state.directorySelectionResolver;
    state.directorySelectionResolver = null;
    const selectedPath = state.directory.path;
    if (elements.directoryDialog.open) elements.directoryDialog.close();
    resolveSelection(selectedPath);
    return;
  }
  elements.cwdInput.value = state.directory.path;
  localStorage.setItem("codex-pwa-last-directory", state.directory.path);
  closeDirectoryBrowser();
  elements.cwdInput.focus();
}

async function selectServerDirectory(initialPath) {
  closeAllMenus();
  elements.directoryDialogTitle.textContent = "选择目标目录";
  elements.newDirectoryForm.classList.add("hidden");
  elements.newDirectoryInput.value = "";
  if (!elements.directoryDialog.open) elements.directoryDialog.showModal();
  const selection = new Promise((resolveSelection) => {
    state.directorySelectionResolver = resolveSelection;
  });
  const fallback = state.roots[0] || "";
  try {
    await loadDirectory(initialPath || fallback);
  } catch (error) {
    if (!fallback || initialPath === fallback) {
      showToast(error.message, 5200);
      closeDirectoryBrowser();
    } else {
      showToast("目标目录不可浏览，已打开授权根目录", 4200);
      await loadDirectory(fallback).catch((fallbackError) => {
        showToast(fallbackError.message, 5200);
        closeDirectoryBrowser();
      });
    }
  }
  return selection;
}

async function createNewDirectory(event) {
  event.preventDefault();
  if (!state.directory.path || state.directory.loading) return;
  const name = elements.newDirectoryInput.value.trim();
  if (!name) return;
  const confirmed = await requestConfirmation({
    eyebrow: "CREATE FOLDER",
    title: "确认创建这个文件夹？",
    message: `${state.directory.path}/${name}\n\n文件夹会创建在服务器授权目录内。`,
    confirmLabel: "确认创建",
  });
  if (!confirmed) return;
  const submit = elements.newDirectoryForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "正在创建…";
  try {
    const result = await api("/api/directories", {
      method: "POST",
      headers: { "X-Codex-PWA-Directory": "1" },
      body: JSON.stringify({ parent: state.directory.path, name }),
    });
    elements.newDirectoryForm.classList.add("hidden");
    elements.newDirectoryInput.value = "";
    await loadDirectory(result.path);
    showToast("文件夹已创建");
  } catch (error) {
    showToast(error.message, 5200);
  } finally {
    submit.disabled = false;
    submit.textContent = "创建并进入";
  }
}

function formatTimestampMs(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(Number(value)));
}

function renderFileBrowserRoots() {
  elements.fileBrowserRoots.replaceChildren();
  for (const root of state.fileBrowser.roots) {
    const button = el("button", "directory-root-button", root.name);
    button.type = "button";
    button.title = root.path;
    button.classList.toggle("active", pathWithinDirectory(state.fileBrowser.path, root.path));
    button.addEventListener("click", () => loadFileBrowser(root.path).catch((error) => showToast(error.message)));
    elements.fileBrowserRoots.append(button);
  }
  elements.fileBrowserRoots.classList.toggle("hidden", state.fileBrowser.roots.length < 2);
}

function createFileBrowserEntry(entry, { parent = false } = {}) {
  const row = el("div", "file-entry");
  row.title = entry.path;
  const isDirectory = parent || entry.type === "directory";
  row.append(el("span", "file-entry-icon", parent ? "↰" : isDirectory ? "▰" : entry.previewKind === "image" ? "▧" : entry.previewKind === "pdf" ? "PDF" : "▤"));
  const copy = el("div", "file-entry-copy");
  copy.append(
    el("span", "file-entry-name", parent ? "上一级" : entry.name),
    el("span", "file-entry-meta", isDirectory
      ? (parent ? entry.path : `文件夹 · ${formatTimestampMs(entry.modifiedAt)}`)
      : `${formatUploadSize(entry.size || 0)} · ${formatTimestampMs(entry.modifiedAt)}`),
  );
  const actions = el("div", "file-entry-actions");
  const menuItems = [];
  const addMenuAction = (label, handler, { danger = false } = {}) => {
    menuItems.push({ label, handler, danger });
  };
  const addMenuLink = (label, href, { download = false, target = "" } = {}) => {
    menuItems.push({ label, href, download: download ? entry.name : "", target });
  };
  if (isDirectory) {
    const open = el("button", "", "打开");
    open.type = "button";
    open.addEventListener("click", () => loadFileBrowser(entry.path).catch((error) => showToast(error.message)));
    addMenuAction("打开", () => open.click());
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.addEventListener("click", (event) => {
      if (!event.target.closest("details, button, a")) open.click();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open.click();
      }
    });
  } else {
    const preview = el("a", "", "预览");
    preview.href = filePreviewHref(entry.path);
    preview.target = "_blank";
    preview.rel = "noopener noreferrer";
    const download = el("a", "", "下载");
    download.href = `/api/files/raw?path=${encodeURIComponent(entry.path)}&download=1`;
    download.download = entry.name;
    preview.target = "_blank";
    preview.rel = "noopener noreferrer";
    addMenuLink("预览", preview.href, { target: "_blank" });
    addMenuLink("下载", download.href, { download: true });
  }
  if (!parent) {
    addMenuAction("复制路径", async () => {
      showToast(await copyText(entry.path) ? "路径已复制" : "复制路径失败", 2600);
    });
    addMenuAction("重命名", () => operateFileBrowserEntry("rename", entry));
    addMenuAction("移动", () => operateFileBrowserEntry("move", entry));
    addMenuAction("复制", () => operateFileBrowserEntry("copy", entry));
    addMenuAction("删除", () => operateFileBrowserEntry("delete", entry), { danger: true });
    const menuButton = el("button", "file-entry-menu-button", "•••");
    menuButton.type = "button";
    menuButton.setAttribute("aria-label", `${entry.name} 操作`);
    menuButton.setAttribute("aria-haspopup", "menu");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openFloatingMenu(menuButton, row, menuItems);
    });
    actions.append(menuButton);
  }
  row.append(copy, actions);
  return row;
}

async function operateFileBrowserEntry(operation, entry) {
  if (!entry?.path || state.fileBrowser.loading) return;
  let name = "";
  let targetDirectory = "";
  if (operation === "rename") {
    name = window.prompt("输入新的名称", entry.name || basename(entry.path));
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    const confirmed = await requestConfirmation({
      eyebrow: "RENAME FILE",
      title: "确认重命名这个项目？",
      message: `${entry.path}\n→ ${name}\n\n重命名会改变项目路径，可能影响引用它的任务或脚本。`,
      confirmLabel: "确认重命名",
    });
    if (!confirmed) return;
  } else if (operation === "move" || operation === "copy") {
    targetDirectory = await selectServerDirectory(state.fileBrowser.path);
    if (!targetDirectory) return;
    const confirmed = await requestConfirmation({
      eyebrow: operation === "move" ? "MOVE FILE" : "COPY FILE",
      title: operation === "move" ? "确认移动这个项目？" : "确认复制这个项目？",
      message: `${entry.path}\n→ ${targetDirectory}\n\n如果目标位置存在同名项目，操作会安全失败，不会覆盖原文件。`,
      confirmLabel: operation === "move" ? "确认移动" : "确认复制",
    });
    if (!confirmed) return;
  } else if (operation === "delete") {
    const confirmed = await requestConfirmation({
      eyebrow: "DELETE FILE",
      title: `删除“${entry.name || basename(entry.path)}”？`,
      message: entry.type === "directory"
        ? "仅允许删除空目录；文件、任务和其他目录不会被自动清理。"
        : `${entry.path}\n\n删除后无法从 Codex Remote 恢复，请确认已有备份。`,
      confirmLabel: "确认删除",
      danger: true,
    });
    if (!confirmed) return;
  }
  setFileBrowserLoading(true);
  try {
    const result = await api("/api/files/operations", {
      method: "POST",
      headers: { "X-Codex-PWA-File-Operation": "1" },
      body: JSON.stringify({ operation, path: entry.path, name, targetDirectory }),
    });
    await loadFileBrowser(state.fileBrowser.path, { preserveSearch: true });
    if (result.cleanupPending) {
      showToast(`移动已完成；旧位置的隐藏临时副本稍后需要清理：${result.cleanupPending}`, 9000);
    } else {
      showToast(operation === "rename" ? "已重命名" : operation === "move" ? "已移动" : operation === "copy" ? "已复制" : "已删除");
    }
  } catch (error) {
    setFileBrowserLoading(false);
    renderFileBrowserList();
    showToast(`文件操作失败：${error.message}`, 5200);
  }
}

async function createFileBrowserFolder() {
  if (!state.fileBrowser.path || state.fileBrowser.loading) return;
  const name = window.prompt("输入新文件夹名称", "new-folder");
  if (name === null || !name.trim()) return;
  const folderName = name.trim();
  const confirmed = await requestConfirmation({
    eyebrow: "CREATE FOLDER",
    title: "确认创建这个文件夹？",
    message: `${state.fileBrowser.path}/${folderName}\n\n文件夹会创建在服务器授权目录内。`,
    confirmLabel: "确认创建",
  });
  if (!confirmed) return;
  try {
    await api("/api/directories", {
      method: "POST",
      headers: { "X-Codex-PWA-Directory": "1" },
      body: JSON.stringify({ parent: state.fileBrowser.path, name: folderName }),
    });
    await loadFileBrowser(state.fileBrowser.path, { preserveSearch: true });
    showToast("文件夹已创建");
  } catch (error) {
    showToast(`创建文件夹失败：${error.message}`, 5200);
  }
}

async function uploadFilesToBrowserDirectory(selectedFiles) {
  const files = [...selectedFiles].filter((file) => file.size <= MAX_UPLOAD_FILE_SIZE);
  if (!files.length) {
    showToast("没有可上传的文件（单文件上限 256 MB）", 5200);
    return;
  }
  if (state.uploadRequest) {
    showToast("已有文件正在上传");
    return;
  }
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_UPLOAD_BATCH_SIZE) {
    showToast("单批文件总大小不能超过 512 MB", 5200);
    return;
  }
  const confirmed = await requestConfirmation({
    eyebrow: "UPLOAD FILES",
    title: "确认上传这些文件？",
    message: `目标目录：${state.fileBrowser.path}\n${confirmationPreview(files.map((file) => file.name).join("\n"), 900)}\n\n文件会写入服务器目录；同名文件不会被自动覆盖。`,
    confirmLabel: "确认上传",
  });
  if (!confirmed) return;
  const form = new FormData();
  files.forEach((file) => form.append("files", file, file.name));
  const request = new XMLHttpRequest();
  state.uploadRequest = request;
  state.uploadContext = "browser";
  elements.uploadToDirectoryButton.disabled = true;
  elements.uploadToDirectoryButton.textContent = "上传中…";
  request.open("POST", `/api/files/upload?cwd=${encodeURIComponent(state.fileBrowser.path)}`);
  request.setRequestHeader("X-Codex-PWA-Upload", "1");
  if (state.auth.csrfToken) request.setRequestHeader("X-Codex-PWA-CSRF", state.auth.csrfToken);
  const cleanup = () => {
    if (state.uploadRequest === request) {
      state.uploadRequest = null;
      state.uploadContext = null;
    }
    elements.uploadToDirectoryButton.disabled = false;
    elements.uploadToDirectoryButton.textContent = "＋ 上传";
  };
  request.addEventListener("load", async () => {
    let payload = {};
    try { payload = JSON.parse(request.responseText || "{}"); } catch {}
    cleanup();
    if (request.status >= 200 && request.status < 300) {
      await loadFileBrowser(state.fileBrowser.path, { preserveSearch: true }).catch(() => {});
      showToast(`已上传 ${payload.files?.length || files.length} 个文件`);
    } else showToast(payload.error || `上传失败（HTTP ${request.status}）`, 5200);
  });
  request.addEventListener("error", () => { cleanup(); showToast("上传连接中断", 5200); });
  request.addEventListener("abort", () => { cleanup(); showToast("上传已取消", 3600); });
  request.send(form);
}

function renderFileBrowserList() {
  elements.fileBrowserList.replaceChildren();
  if (!elements.fileBrowserSearch.value.trim() && state.fileBrowser.parent) {
    elements.fileBrowserList.append(createFileBrowserEntry({ path: state.fileBrowser.parent }, { parent: true }));
  }
  for (const entry of state.fileBrowser.entries) elements.fileBrowserList.append(createFileBrowserEntry(entry));
  if (!elements.fileBrowserList.children.length) {
    const empty = el("div", "directory-empty");
    empty.append(el("strong", "", "没有匹配的文件"), el("span", "", "换一个关键词或目录试试。"));
    elements.fileBrowserList.append(empty);
  }
  elements.fileBrowserLimitNotice.classList.toggle("hidden", !state.fileBrowser.truncated);
}

function setFileBrowserLoading(loading) {
  state.fileBrowser.loading = loading;
  elements.fileBrowserSearch.disabled = loading;
  elements.showHiddenFiles.disabled = loading;
  elements.uploadToDirectoryButton.disabled = loading || !state.fileBrowser.path || Boolean(state.uploadRequest);
  elements.newFileBrowserFolderButton.disabled = loading || !state.fileBrowser.path;
  elements.refreshFileBrowserButton.disabled = loading;
  elements.newTaskFromDirectoryButton.disabled = loading || !state.fileBrowser.path;
  if (!loading) return;
  const row = el("div", "directory-empty");
  row.append(el("span", "spinner"), el("span", "", "正在读取服务器文件…"));
  elements.fileBrowserList.replaceChildren(row);
  elements.fileBrowserLimitNotice.classList.add("hidden");
}

async function loadFileBrowser(path, { preserveSearch = false } = {}) {
  const sequence = ++state.fileBrowser.loadSequence;
  closeAllMenus();
  if (!preserveSearch) elements.fileBrowserSearch.value = "";
  setFileBrowserLoading(true);
  const loadingToken = showLoadingToast("正在读取服务器文件…");
  try {
    const params = new URLSearchParams({
      path,
      hidden: String(elements.showHiddenFiles.checked),
      query: elements.fileBrowserSearch.value.trim(),
    });
    const result = await api(`/api/files/list?${params}`);
    if (sequence !== state.fileBrowser.loadSequence) return;
    Object.assign(state.fileBrowser, {
      path: result.path,
      parent: result.parent || null,
      roots: result.roots || [],
      entries: result.entries || [],
      truncated: Boolean(result.truncated),
    });
    localStorage.setItem("codex-pwa-file-browser-path", result.path);
    elements.fileBrowserCurrentPath.textContent = result.path;
    elements.fileBrowserCurrentPath.title = result.path;
    renderFileBrowserRoots();
    renderFileBrowserList();
  } finally {
    finishLoadingToast(loadingToken);
    if (sequence === state.fileBrowser.loadSequence) setFileBrowserLoading(false);
  }
}

async function openFileBrowser() {
  const fallback = state.roots[0] || "";
  const requested = state.fileBrowser.path || state.selectedThread?.cwd || fallback;
  closeAllMenus();
  if (!elements.fileBrowserDialog.open) elements.fileBrowserDialog.showModal();
  closeSidebar();
  try {
    await loadFileBrowser(requested);
  } catch (error) {
    if (requested !== fallback) await loadFileBrowser(fallback).catch(() => {});
    showToast(error.message, 5200);
  }
}

function closeFileBrowser() {
  if (elements.fileBrowserDialog.open) elements.fileBrowserDialog.close();
}

function deviceClientLabel(userAgent) {
  const value = String(userAgent || "");
  const platform = /android/i.test(value) ? "Android" : /iphone|ipad/i.test(value) ? "iOS / iPadOS" : /windows/i.test(value) ? "Windows" : /macintosh|mac os/i.test(value) ? "macOS" : "浏览器";
  const browser = /edg\//i.test(value) ? "Edge" : /chrome\//i.test(value) ? "Chrome" : /firefox\//i.test(value) ? "Firefox" : /safari\//i.test(value) ? "Safari" : "Web";
  return `${platform} · ${browser}`;
}

function openDeviceRename(device) {
  state.deviceRenameTargetId = device.id;
  elements.deviceRenameInput.value = device.label || "此设备";
  elements.deviceRenameDialog.showModal();
  setTimeout(() => elements.deviceRenameInput.select(), 40);
}

function openCredentialsDialog() {
  closeAllMenus();
  elements.currentUsernameInput.value = state.auth.username || elements.loginUsername.value.trim() || "codex";
  elements.currentPasswordInput.value = "";
  elements.newUsernameInput.value = elements.currentUsernameInput.value;
  elements.newPasswordInput.value = "";
  elements.confirmNewPasswordInput.value = "";
  elements.credentialsError.textContent = "";
  elements.credentialsError.classList.add("hidden");
  elements.credentialsError.classList.remove("notice");
  if (elements.devicesDialog.open) elements.devicesDialog.close();
  elements.credentialsDialog.showModal();
  setTimeout(() => elements.currentPasswordInput.focus(), 40);
}

async function saveCredentials(event) {
  event.preventDefault();
  const newPassword = elements.newPasswordInput.value;
  if (!elements.newUsernameInput.value.trim() && !newPassword) {
    elements.credentialsError.textContent = "新用户名或新密码至少填写一项";
    elements.credentialsError.classList.remove("hidden");
    elements.credentialsError.classList.remove("notice");
    elements.newUsernameInput.focus();
    return;
  }
  if (newPassword || elements.confirmNewPasswordInput.value) {
    if (newPassword !== elements.confirmNewPasswordInput.value) {
      elements.credentialsError.textContent = "两次输入的新密码不一致";
      elements.credentialsError.classList.remove("hidden");
      elements.credentialsError.classList.remove("notice");
      elements.confirmNewPasswordInput.select();
      return;
    }
  }
  elements.saveCredentialsButton.disabled = true;
  elements.saveCredentialsButton.textContent = "正在保存…";
  elements.credentialsError.classList.add("hidden");
  try {
    const result = await api("/api/auth/credentials/change", {
      method: "POST",
      body: JSON.stringify({
        currentUsername: elements.currentUsernameInput.value.trim(),
        currentPassword: elements.currentPasswordInput.value,
        newUsername: elements.newUsernameInput.value.trim(),
        newPassword,
      }),
    });
    elements.loginUsername.value = result.username || elements.newUsernameInput.value.trim();
    elements.credentialsDialog.close();
    showLogin("用户名或密码已更新，请使用新凭据重新登录");
  } catch (error) {
    elements.credentialsError.textContent = error.message;
    elements.credentialsError.classList.remove("hidden");
    elements.credentialsError.classList.remove("notice");
    elements.currentPasswordInput.select();
  } finally {
    elements.saveCredentialsButton.disabled = false;
    elements.saveCredentialsButton.textContent = "保存并重新登录";
  }
}

function renderDevices() {
  elements.devicesList.replaceChildren();
  elements.logoutOtherDevicesButton.disabled = !state.devices.some((device) => !device.current);
  if (!state.devices.length) {
    const empty = el("div", "directory-empty");
    empty.append(el("strong", "", "没有有效的可信设备"), el("span", "", "重新登录后会在这里显示。"));
    elements.devicesList.append(empty);
    return;
  }
  for (const device of state.devices) {
    const card = el("article", `device-card${device.current ? " current" : ""}`);
    card.append(el("span", "device-icon", /android|iphone|ipad/i.test(device.userAgent || "") ? "▯" : "▰"));
    const copy = el("div", "device-copy");
    const title = el("div", "device-title");
    title.append(el("strong", "", device.label || "此设备"));
    if (device.current) title.append(el("span", "device-badge", "当前设备"));
    if (device.online) title.append(el("span", "device-badge", "在线"));
    copy.append(
      title,
      el("span", "device-meta", deviceClientLabel(device.userAgent)),
      el("span", "device-meta", `最后使用：${formatTimestampMs(device.lastUsedAt)} · 到期：${formatTimestampMs(device.expiresAt)}`),
    );
    const actions = el("div", "device-actions");
    const rename = el("button", "", "重命名");
    rename.type = "button";
    rename.addEventListener("click", () => openDeviceRename(device));
    const revoke = el("button", "danger", device.current ? "退出此设备" : "撤销");
    revoke.type = "button";
    revoke.addEventListener("click", async () => {
      const confirmed = await requestConfirmation({
        eyebrow: device.current ? "LOG OUT DEVICE" : "REVOKE DEVICE",
        title: device.current ? "退出当前设备？" : "撤销这个可信设备？",
        message: device.current
          ? "退出后本设备需要重新输入密码才能继续使用。"
          : `设备：${device.label || "此设备"}\n\n撤销后该设备需要重新登录。`,
        confirmLabel: device.current ? "退出此设备" : "确认撤销",
        danger: true,
      });
      if (!confirmed) return;
      try {
        const result = await api(`/api/auth/devices/${encodeURIComponent(device.id)}`, { method: "DELETE", body: "{}" });
        if (result.current) {
          if (elements.deviceRenameDialog.open) elements.deviceRenameDialog.close();
          if (elements.devicesDialog.open) elements.devicesDialog.close();
          showLogin("已退出当前设备，请重新登录");
          return;
        }
        await loadDevices();
        showToast("设备已撤销");
      } catch (error) { showToast(error.message, 5200); }
    });
    actions.append(rename, revoke);
    card.append(copy, actions);
    elements.devicesList.append(card);
  }
}

async function loadDevices() {
  const loadingToken = showLoadingToast("正在加载已登录设备…");
  try {
    const result = await api("/api/auth/devices");
    state.devices = result.devices || [];
    renderDevices();
  } finally {
    finishLoadingToast(loadingToken);
  }
}

async function openDevices() {
  closeAllMenus();
  if (!elements.devicesDialog.open) elements.devicesDialog.showModal();
  closeSidebar();
  elements.devicesList.replaceChildren(el("div", "directory-empty", "正在读取可信设备…"));
  try { await loadDevices(); } catch (error) { showToast(error.message, 5200); }
}

async function renameDevice(event) {
  event.preventDefault();
  const id = state.deviceRenameTargetId;
  if (!id) return;
  try {
    await api(`/api/auth/devices/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ label: elements.deviceRenameInput.value.trim() }),
    });
    elements.deviceRenameDialog.close();
    await loadDevices();
    showToast("设备名称已更新");
  } catch (error) { showToast(error.message, 5200); }
}

async function logoutOtherDevices() {
  const confirmed = await requestConfirmation({
    eyebrow: "LOG OUT OTHER DEVICES",
    title: "注销其他可信设备？",
    message: "当前设备会保留登录状态，其他手机和浏览器需要重新登录。",
    confirmLabel: "确认注销",
    danger: true,
  });
  if (!confirmed) return;
  try {
    const result = await api("/api/auth/logout-others", { method: "POST", body: "{}" });
    await loadDevices();
    showToast(`已注销 ${result.revoked || 0} 台其他设备`);
  } catch (error) { showToast(error.message, 5200); }
}

function supportTaskCwd() {
  const candidates = [state.appRoot, state.selectedThread?.cwd, stored.lastDirectory, state.roots[0]];
  return candidates.find((candidate) => candidate && state.roots.some((root) => pathWithinDirectory(candidate, root))) || state.roots[0] || "";
}

function supportTaskPrompt(question, mode = "help") {
  const appVersion = state.version || "未知";
  const maintenance = mode === "maintenance";
  return [
    "你是 Codex Remote PWA 的支持与维护助手。",
    `当前 PWA 版本：${appVersion}`,
    "请先阅读当前安装目录中的 README.md、SECURITY.md，以及与问题相关的源码。",
    maintenance
      ? "这是一个候选 UI 改进需求。第一轮只做只读分析，列出问题原因、修改范围、风险和测试计划；只有用户在本任务中明确回复“开始实施”后才可以编辑代码。"
      : "这是一次使用问题咨询。默认只做解释、诊断和安全建议，不修改任何文件。",
    "绝对不要触碰 ~/.codex、Codex 任务历史、无关项目文件或 COMSOL 数据；不要重启 Linux 服务器，不要停止或重启 Codex daemon。若后续获准修改，只能使用 apply_patch，并先说明影响范围，完成 npm run check 后再汇报。",
    `用户问题：\n${String(question || "请介绍这套 PWA 的基本使用方法，并列出常见故障排查步骤。").trim()}`,
  ].join("\n\n");
}

function openHelp() {
  closeAllMenus();
  if (!elements.helpDialog.open) elements.helpDialog.showModal();
  closeSidebar();
}

function startSupportTask(mode = "help") {
  const question = elements.helpQuestionInput.value.trim();
  if (!question) {
    showToast("请先填写想咨询的问题", 3600);
    elements.helpQuestionInput.focus();
    return;
  }
  elements.helpDialog.close();
  openNewTaskDialog(supportTaskPrompt(question, mode));
  elements.cwdInput.value = supportTaskCwd();
  elements.newPermissionSelect.value = "request";
}

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
  submit.textContent = "正在核对任务列表…";
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
      showToast("任务已在服务器创建，刚才的超时结果已经核对完成", 5200);
      return;
    }
    showToast("启动请求的结果仍未确认。请先检查会话列表，确认没有新任务后再重新创建。", 9000);
  } catch (error) {
    showToast(`暂时无法核对任务列表：${error.message}。请勿立即重复创建。`, 9000);
  } finally {
    state.taskStartReconciliation = false;
    submit.disabled = false;
    submit.textContent = "开始任务";
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
    showToast("Goal token 预算必须是非负整数");
    return;
  }
  const confirmed = await requestConfirmation({
    eyebrow: "START TASK",
    title: "确认开始这个任务？",
    message: `工作目录：${cwd}\n模型：${elements.newModelSelect.value || "默认模型"}\n推理：${effortLabel(elements.newEffortSelect.value)}\n权限：${permissionLabels[elements.newPermissionSelect.value] || elements.newPermissionSelect.value}\n\n${confirmationPreview(originalPrompt, 1_200)}${goalObjective ? `\n\nGoal：${confirmationPreview(goalObjective, 600)}` : ""}`,
    confirmLabel: "确认开始",
  });
  if (!confirmed) return;
  const submit = elements.newTaskForm.querySelector('button[type="submit"]');
  const submittedAt = Date.now() / 1000;
  submit.disabled = true;
  let prompt = originalPrompt;
  try {
    if (state.newTaskFiles.length) {
      submit.textContent = "正在上传…";
      const uploaded = await uploadSelectedFiles("new", { cwd: elements.cwdInput.value.trim() });
      prompt = appendUploadedFileReferences(originalPrompt, uploaded);
      clearUploadQueue("new");
      elements.newPromptInput.value = prompt;
    }
    submit.textContent = "正在启动…";
    const result = await api("/api/threads", {
      method: "POST",
      body: JSON.stringify({
        cwd: elements.cwdInput.value.trim(), prompt,
        model: elements.newModelSelect.value,
        effort: elements.newEffortSelect.value,
        permissionPreset: elements.newPermissionSelect.value,
        ...(goalObjective ? { goal: { objective: goalObjective, tokenBudget: goalBudget, status: "active" } } : {}),
      }),
    });
    state.newTaskModel = elements.newModelSelect.value;
    state.newTaskEffort = elements.newEffortSelect.value;
    state.newTaskPermission = elements.newPermissionSelect.value;
    localStorage.setItem("codex-pwa-model", state.newTaskModel);
    localStorage.setItem("codex-pwa-effort", state.newTaskEffort);
    localStorage.setItem("codex-pwa-permission", state.newTaskPermission);
    localStorage.setItem("codex-pwa-last-directory", elements.cwdInput.value.trim());
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
    renderOptimisticUserMessage(prompt, { turnId: state.activeTurnId });
    updateTurnControls();
    if (result.goalError) showToast(`任务已启动，但 Goal 未写入：${result.goalError}`, 5200);
    await loadThreads({ silent: true });
  } catch (error) {
    if (error.outcomeUnknown) {
      showToast("启动请求已提交，但 Codex 尚未确认结果；正在自动核对任务列表，请不要重复创建。", 9000);
      reconcileUnknownTaskStart({ cwd, prompt, submittedAt, submit });
    } else {
      showToast(error.message);
    }
  } finally {
    if (!state.taskStartReconciliation) {
      submit.disabled = false;
      submit.textContent = "开始任务";
    }
  }
}

function restoreViewportPosition() {
  // Mobile Chrome can leave the layout viewport scrolled after dismissing the
  // virtual keyboard. Reset both possible scroll containers on the next frame
  // so the top bar and conversation do not remain partially hidden.
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    resizeComposer();
  });
}

function syncViewportHeight({ restore = false } = {}) {
  const viewport = window.visualViewport;
  const height = Math.max(1, Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 1));
  const offsetTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
  const previousHeight = state.viewport.height;
  state.viewport.height = height;
  state.viewport.offsetTop = offsetTop;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
  document.documentElement.style.setProperty("--viewport-offset-top", `${offsetTop}px`);

  // A keyboard dismissal normally arrives as a visualViewport resize that
  // increases the available height. Treat that transition as a signal to
  // restore the page position; do not do so while the keyboard is opening.
  if (restore || (previousHeight > 0 && height > previousHeight + 24)) restoreViewportPosition();
  else resizeComposer();
}

function queueViewportSync({ restore = false } = {}) {
  syncViewportHeight({ restore });
  for (const timer of state.viewport.syncTimers) clearTimeout(timer);
  state.viewport.syncTimers = [];
  // Android Chrome may emit a few delayed visualViewport updates while its
  // keyboard animation settles. Re-read the value after each short interval.
  const delays = restore ? [80, 240, 520] : [120];
  for (const delay of delays) {
    state.viewport.syncTimers.push(setTimeout(() => syncViewportHeight({ restore }), delay));
  }
}

function resizeComposer() {
  elements.promptInput.style.height = "auto";
  const minHeight = 58;
  elements.promptInput.style.height = `${Math.min(Math.max(elements.promptInput.scrollHeight, minHeight), 190)}px`;
}

async function sendPrompt(event) {
  event.preventDefault();
  if (!state.selectedThread) return openNewTaskDialog(elements.promptInput.value.trim());
  if (state.uploadRequest) return;
  const originalPrompt = elements.promptInput.value.trim();
  if (!originalPrompt) return;
  const threadId = state.selectedThread.id;
  const viewingHistory = state.historyContext.active;
  const running = Boolean(state.activeTurnId);
  const attachmentNote = state.pendingFiles.length
    ? `\n附件：${state.pendingFiles.length} 个（会先保存到任务工作目录）`
    : "";
  const confirmed = await requestConfirmation({
    eyebrow: viewingHistory ? "RETURN TO LATEST" : running ? "STEER TASK" : "SEND PROMPT",
    title: viewingHistory ? "返回最新对话并发送？" : running ? "确认追加这条指令？" : "确认发送这条消息？",
    message: `${confirmationPreview(originalPrompt, 1_200)}\n\n${viewingHistory ? "发送前会退出历史节点视图，并按任务的最新运行状态提交。" : running ? "这条指令会追加到当前运行中的任务。" : "这条消息会启动新一轮任务。"}${attachmentNote}`,
    confirmLabel: viewingHistory ? "返回并发送" : running ? "确认追加" : "确认发送",
  });
  if (!confirmed) return;
  if (state.historyContext.active) {
    elements.sendButton.disabled = true;
    const restored = await returnToLatestConversation();
    elements.sendButton.disabled = false;
    if (!restored) {
      showToast("未能返回最新对话，消息没有发送", 5200);
      return;
    }
  }
  if (state.selectedThread?.id !== threadId) {
    showToast("任务已切换，未发送这条消息", 3600);
    return;
  }
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
    if (state.selectedThread?.id !== threadId) throw new Error("上传期间任务已切换；文件已保存到原任务目录");
    elements.promptInput.value = "";
    resizeComposer();
    const existingTurnId = state.activeTurnId;
    optimistic = renderOptimisticUserMessage(prompt, { turnId: existingTurnId });
    rendered = true;
    scrollToBottom(true);
    if (existingTurnId) {
      await api(`/api/threads/${encodeURIComponent(threadId)}/steer`, {
        method: "POST", body: JSON.stringify({ prompt, turnId: existingTurnId }),
      });
      if (hasPendingSettings(threadId)) showToast("补充指令已发送；待应用设置会保留到下一轮");
    } else {
      const result = await api(`/api/threads/${encodeURIComponent(threadId)}/turns`, {
        method: "POST", body: JSON.stringify({ prompt, settings: pendingSettings(threadId) }),
      });
      commitEffectiveSettings(threadId, result.settings);
      state.ownedThreads.add(threadId);
      state.releasingThreads.delete(threadId);
      state.activeTurnId = result.turn?.id || null;
      assignOptimisticMessageTurn(optimistic?.id, state.activeTurnId);
      updateChatActions();
      updateTurnControls();
      updateOptionChips();
    }
    clearThreadDraft(threadId);
  } catch (error) {
    if (error.outcomeUnknown && rendered) {
      clearThreadDraft(threadId);
      optimistic?.element?.classList.add("outcome-unknown");
      optimistic?.element?.setAttribute("title", "服务器尚未确认接收结果；请等待自动刷新核对");
      showToast("消息已提交，但 Codex 尚未确认结果。正在刷新核对，请不要重复发送。", 9000);
      setTimeout(() => {
        if (state.selectedThread?.id === threadId) refreshSelectedThread({ preserveScroll: true }).catch(() => {});
      }, 1_200);
    } else {
      elements.promptInput.value = rendered ? prompt : originalPrompt;
      resizeComposer();
    }
    if (rendered && !error.outcomeUnknown) {
      discardOptimisticMessage(optimistic?.id);
      showToast(`发送失败：${error.message}`, 5200);
    } else if (!error.outcomeUnknown) {
      showToast(error.message, 5200);
    }
    if (!error.outcomeUnknown) saveThreadDraft(threadId, elements.promptInput.value);
  } finally {
    elements.sendButton.disabled = false;
  }
}

async function stopTurn() {
  const threadId = state.selectedThread?.id;
  const turnId = state.activeTurnId;
  if (!threadId || !turnId) return;
  const confirmed = await requestConfirmation({
    eyebrow: "STOP TASK",
    title: "中止当前任务？",
    message: "中止后本轮将停止，已经产生的文件修改不会自动撤销。",
    confirmLabel: "确认中止",
    danger: true,
  });
  if (!confirmed) return;
  if (state.selectedThread?.id !== threadId || state.activeTurnId !== turnId) {
    updateTurnControls();
    showToast("任务状态已变化，未执行中止", 3600);
    return;
  }
  elements.stopButton.disabled = true;
  try {
    await api(`/api/threads/${encodeURIComponent(threadId)}/interrupt`, {
      method: "POST", body: JSON.stringify({ turnId }),
    });
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.stopButton.disabled = false;
    updateTurnControls();
  }
}

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

function handleNotification(message) {
  const { method, params = {} } = message;
  const selectedId = state.selectedThread?.id;

  if (method === "thread/status/changed") {
    updateThreadStatus(params.threadId, params.status);
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
  if (params.threadId && params.threadId !== selectedId) return;

  const browsingHistory = state.historyContext.active && state.historyContext.threadId === selectedId;
  if (browsingHistory && historyContextDefersNotification(method)) {
    if (method === "turn/plan/updated") state.plan = params;
    markHistoryContextUpdated();
    return;
  }

  const follow = shouldFollowOutput();
  if (method === "turn/started") {
    if (params.threadId) {
      state.ownedThreads.add(params.threadId);
      state.releasingThreads.delete(params.threadId);
    }
    state.activeTurnId = params.turn?.id || state.activeTurnId;
    if (browsingHistory) markHistoryContextUpdated();
    else turnGroup(state.activeTurnId, { create: Boolean(state.activeTurnId) });
    if (state.selectedThread) state.selectedThread.status = { type: "active", activeFlags: [] };
    updateTurnControls(); updateChatActions(); updateChatHeader(); renderThreads();
  } else if (method === "turn/completed") {
    state.activeTurnId = null;
    if (state.selectedThread) state.selectedThread.status = { type: "idle" };
    const turn = params.turn;
    if (browsingHistory) {
      markHistoryContextUpdated();
    } else {
      const group = turn?.id ? turnGroup(turn.id) : null;
      if (group && turn) syncTurnOutcome(group, turn);
      else if (turn?.status === "failed" && turn.error) elements.messages.append(el("div", "turn-error", turn.error.message || "任务执行失败"));
      else if (turn?.status === "interrupted") elements.messages.append(el("div", "turn-divider", "已停止"));
    }
    updateTurnControls(); updateChatActions(); updateChatHeader();
    loadThreads({ silent: true }).catch(() => {});
    if (params.threadId && !browsingHistory) {
      setTimeout(() => loadThreadArtifacts(params.threadId).catch(() => {}), 500);
    }
  } else if (method === "item/agentMessage/delta") {
    const turnId = params.turnId || state.activeTurnId;
    if (turnId) state.itemTurns.set(params.itemId, turnId);
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
      const next = appendBoundedLiveText(node.fullText, delta, MAX_LIVE_COMMAND_CHARS);
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
    renderItem(params.item, turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages, { turnId });
  } else if (method === "item/completed") {
    const item = params.item;
    if (item?.type === "agentMessage") {
      state.itemText.set(item.id, boundedLiveText(item.text || state.itemText.get(item.id) || "").text);
    }
    const turnId = params.turnId || state.activeTurnId;
    renderItem(item, turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages, { turnId });
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
  } else if (method === "serverRequest/resolved") {
    const requestId = String(params.requestId ?? params.id ?? "");
    if (requestId && state.approvals.delete(requestId)) state.approvalRevision += 1;
    renderApprovals();
  }
  if (follow) requestAnimationFrame(() => scrollToBottom(true));
}

function connectEvents({ generation = null } = {}) {
  if (!state.auth.authenticated) return;
  if (generation === null) {
    state.eventGeneration += 1;
    generation = state.eventGeneration;
  }
  if (generation !== state.eventGeneration) return;
  clearTimeout(state.eventReconnectTimer);
  state.eventReconnectTimer = null;
  state.eventSource?.close();
  state.eventSource = null;
  if (navigator.onLine === false) {
    state.offlineSince ||= Date.now();
    setConnection("offline");
    scheduleEventReconnect(generation);
    return;
  }
  setConnection(state.eventReconnectAttempt ? "reconnecting" : "connecting");
  const events = new EventSource("/api/events");
  state.eventSource = events;
  events.onopen = () => {
    if (generation !== state.eventGeneration || state.eventSource !== events) return;
    state.eventReconnectAttempt = 0;
    state.offlineSince = null;
    setConnection("ready");
    runVisibleRecovery().catch(() => {});
  };
  events.onerror = () => {
    if (generation !== state.eventGeneration || state.eventSource !== events) return;
    events.close();
    state.eventSource = null;
    state.eventReconnectAttempt += 1;
    if (navigator.onLine === false) {
      state.offlineSince ||= Date.now();
      setConnection("offline");
    } else {
      setConnection("reconnecting");
    }
    scheduleEventReconnect(generation);
  };
  events.onmessage = (event) => {
    if (generation !== state.eventGeneration || state.eventSource !== events) return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.kind === "bridge/status") setConnection(payload.status, payload.error);
    else if (payload.kind === "bridge/threadOwnership") {
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
    }
    else if (payload.kind === "app-server/notification") handleNotification(payload.message);
    else if (payload.kind === "app-server/request") {
      state.approvals.set(payload.requestId, payload);
      state.approvalRevision += 1;
      const requestThreadId = payload.params?.threadId;
      if (requestThreadId && requestThreadId !== state.selectedThread?.id) {
        updateThreadStatus(requestThreadId, { type: "active", activeFlags: [isQuestionRequest(payload.method) ? "waitingOnUserInput" : "waitingOnApproval"] });
        showToast("另一个任务正在等待你的操作");
      }
      renderApprovals();
    } else if (payload.kind === "bridge/log" && payload.level === "error") {
      console.warn(payload.message);
    }
  };
}

function openSettingsDialog() {
  if (!state.selectedThread) return;
  closeAllMenus();
  syncSettingsControls();
  elements.settingsDialog.showModal();
}

function saveSettings(event) {
  event.preventDefault();
  if (!state.selectedThread) return;
  const current = settingsState();
  const effective = current.effective;
  const selected = {
    model: elements.settingsModelSelect.value || effective.model || "",
    effort: elements.settingsEffortSelect.value || null,
    permissionPreset: elements.settingsPermissionSelect.value === "custom"
      ? effective.permissionPreset || "custom"
      : elements.settingsPermissionSelect.value,
  };
  const pending = {};
  for (const key of ["model", "effort", "permissionPreset"]) {
    if ((selected[key] ?? null) !== (effective[key] ?? null)) pending[key] = selected[key];
  }
  current.pending = pending;
  updateOptionChips();
  updateTurnControls();
  elements.settingsDialog.close();
  showToast(Object.keys(pending).length
    ? state.activeTurnId ? "设置已暂存，将在下一轮新消息生效" : "设置已暂存，成功发送下一条消息后生效"
    : "已恢复为当前任务设置");
}

function closeOpenMenus(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (state.floatingMenu?.anchor?.contains(target) || target.closest(".floating-popover")) return;
  closeFloatingMenu();
  const owner = target.closest("details.menu-popover");
  document.querySelectorAll("details.menu-popover[open]").forEach((details) => {
    if (details !== owner) details.open = false;
  });
}

function closeFloatingMenu() {
  const menu = state.floatingMenu;
  if (!menu) return;
  state.floatingMenu = null;
  menu.anchor?.setAttribute("aria-expanded", "false");
  menu.owner?.classList.remove("menu-open");
  menu.element?.remove();
  if (state.threadRenderPending) requestAnimationFrame(() => renderThreads());
}

function closeAllMenus() {
  closeFloatingMenu();
  document.querySelectorAll("details.menu-popover[open]").forEach((details) => {
    details.open = false;
  });
}

function wireFileDrop(zone, context) {
  zone.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    zone.classList.add("drop-active");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drop-active"));
  zone.addEventListener("drop", (event) => {
    zone.classList.remove("drop-active");
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    queueSelectedFiles(context, event.dataTransfer.files);
  });
}

function wireEvents() {
  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.loginButton.disabled = true;
    elements.loginButton.textContent = "正在登录…";
    elements.loginError.classList.add("hidden");
    elements.loginError.classList.remove("notice");
    try {
      const session = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: elements.loginUsername.value.trim(),
          password: elements.loginPassword.value,
          remember: elements.rememberDevice.checked,
        }),
      });
      if (state.appStarted) {
        window.location.reload();
        return;
      }
      showApplication(session);
      await startAuthenticatedApp();
    } catch (error) {
      elements.loginError.textContent = error.message;
      elements.loginError.classList.remove("hidden");
      elements.loginPassword.select();
    } finally {
      elements.loginButton.disabled = false;
      elements.loginButton.textContent = "登录";
    }
  });
  elements.changeCredentialsLoginButton.addEventListener("click", openCredentialsDialog);
  elements.logoutButton.addEventListener("click", async () => {
    const confirmed = await requestConfirmation({
      eyebrow: "LOG OUT DEVICE",
      title: "退出当前设备？",
      message: "退出后需要重新输入密码才能继续使用这个浏览器。",
      confirmLabel: "退出当前设备",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
    } catch (error) {
      if (!/登录/.test(error.message)) showToast(error.message);
    }
    showLogin("已退出当前设备");
  });
  elements.logoutAllButton.addEventListener("click", async () => {
    const confirmed = await requestConfirmation({
      eyebrow: "LOG OUT ALL DEVICES",
      title: "注销全部可信设备？",
      message: "所有手机和浏览器都会退出登录，包括当前设备；之后必须重新输入密码。",
      confirmLabel: "确认全部注销",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api("/api/auth/logout-all", { method: "POST", body: "{}" });
      showLogin("已注销全部可信设备");
    } catch (error) {
      showToast(error.message);
    }
  });
  elements.refreshWebUiButton.addEventListener("click", async () => {
    closeSidebar();
    state.updateRequested = true;
    try {
      const registration = await navigator.serviceWorker?.getRegistration?.();
      if (registration?.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
        return;
      }
    } catch {}
    window.location.reload();
  });
  elements.menuButton.addEventListener("click", openSidebar);
  elements.closeSidebarButton.addEventListener("click", closeSidebar);
  elements.sidebarBackdrop.addEventListener("click", closeSidebar);
  elements.newTaskButton.addEventListener("click", () => openNewTaskDialog());
  elements.emptyNewTaskButton.addEventListener("click", () => openNewTaskDialog());
  document.querySelectorAll(".suggestion").forEach((button) => button.addEventListener("click", () => openNewTaskDialog(button.dataset.prompt || "")));
  elements.closeDialogButton.addEventListener("click", () => {
    if (state.uploadRequest && state.uploadContext === "new") {
      showToast("请等待文件上传完成，或在进度条旁取消上传");
      return;
    }
    elements.newTaskDialog.close();
  });
  elements.newTaskForm.addEventListener("submit", createTask);
  elements.browseDirectoryButton.addEventListener("click", openDirectoryBrowser);
  elements.closeDirectoryButton.addEventListener("click", closeDirectoryBrowser);
  elements.chooseDirectoryButton.addEventListener("click", chooseCurrentDirectory);
  elements.directorySearch.addEventListener("input", debounce(() => {
    loadDirectory(state.directory.path || state.roots[0] || "", { preserveSearch: true })
      .catch((error) => showToast(error.message));
  }, 240));
  elements.showHiddenDirectories.addEventListener("change", () => {
    if (!state.directory.path) return;
    loadDirectory(state.directory.path, { preserveSearch: true }).catch((error) => showToast(error.message));
  });
  elements.showNewDirectoryButton.addEventListener("click", () => {
    elements.newDirectoryForm.classList.remove("hidden");
    setTimeout(() => elements.newDirectoryInput.focus(), 30);
  });
  elements.cancelNewDirectoryButton.addEventListener("click", () => {
    elements.newDirectoryForm.classList.add("hidden");
    elements.newDirectoryInput.value = "";
  });
  elements.newDirectoryForm.addEventListener("submit", createNewDirectory);
  elements.directoryDialog.addEventListener("click", (event) => {
    if (event.target === elements.directoryDialog) closeDirectoryBrowser();
  });
  elements.directoryDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDirectoryBrowser();
  });
  elements.serverFilesButton.addEventListener("click", openFileBrowser);
  elements.closeFileBrowserButton.addEventListener("click", closeFileBrowser);
  elements.refreshFileBrowserButton.addEventListener("click", () => {
    if (state.fileBrowser.path) loadFileBrowser(state.fileBrowser.path, { preserveSearch: true }).catch((error) => showToast(error.message));
  });
  elements.fileBrowserSearch.addEventListener("input", debounce(() => {
    if (state.fileBrowser.path) loadFileBrowser(state.fileBrowser.path, { preserveSearch: true }).catch((error) => showToast(error.message));
  }, 300));
  elements.showHiddenFiles.addEventListener("change", () => {
    if (state.fileBrowser.path) loadFileBrowser(state.fileBrowser.path, { preserveSearch: true }).catch((error) => showToast(error.message));
  });
  elements.uploadToDirectoryButton.addEventListener("click", () => elements.fileBrowserUploadInput.click());
  elements.fileBrowserUploadInput.addEventListener("change", () => {
    uploadFilesToBrowserDirectory(elements.fileBrowserUploadInput.files || []);
    elements.fileBrowserUploadInput.value = "";
  });
  elements.newFileBrowserFolderButton.addEventListener("click", createFileBrowserFolder);
  elements.newTaskFromDirectoryButton.addEventListener("click", () => {
    const path = state.fileBrowser.path;
    closeFileBrowser();
    openNewTaskDialog();
    if (path) elements.cwdInput.value = path;
  });
  elements.fileBrowserDialog.addEventListener("click", (event) => {
    if (event.target === elements.fileBrowserDialog) closeFileBrowser();
  });
  elements.trustedDevicesButton.addEventListener("click", openDevices);
  elements.changeCredentialsButton.addEventListener("click", openCredentialsDialog);
  elements.helpButton.addEventListener("click", openHelp);
  elements.closeHelpButton.addEventListener("click", () => elements.helpDialog.close());
  elements.askWebUiButton.addEventListener("click", () => startSupportTask("help"));
  elements.requestUiChangeButton.addEventListener("click", () => startSupportTask("maintenance"));
  elements.helpDialog.addEventListener("click", (event) => {
    if (event.target === elements.helpDialog) elements.helpDialog.close();
  });
  elements.closeDevicesButton.addEventListener("click", () => elements.devicesDialog.close());
  elements.refreshDevicesButton.addEventListener("click", () => loadDevices().catch((error) => showToast(error.message)));
  elements.logoutOtherDevicesButton.addEventListener("click", logoutOtherDevices);
  elements.devicesDialog.addEventListener("click", (event) => {
    if (event.target === elements.devicesDialog) elements.devicesDialog.close();
  });
  elements.closeDeviceRenameButton.addEventListener("click", () => elements.deviceRenameDialog.close());
  elements.deviceRenameForm.addEventListener("submit", renameDevice);
  elements.closeCredentialsButton.addEventListener("click", () => elements.credentialsDialog.close());
  elements.credentialsForm.addEventListener("submit", saveCredentials);
  elements.attachButton.addEventListener("click", () => openAttachmentSource("composer"));
  elements.closeAttachmentSourceButton.addEventListener("click", () => elements.attachmentSourceDialog.close());
  elements.choosePhotoButton.addEventListener("click", () => chooseAttachmentSource("photo"));
  elements.chooseFileButton.addEventListener("click", () => chooseAttachmentSource("file"));
  elements.attachmentSourceDialog.addEventListener("click", (event) => {
    if (event.target === elements.attachmentSourceDialog) elements.attachmentSourceDialog.close();
  });
  elements.fileInput.addEventListener("change", () => {
    queueSelectedFiles("composer", elements.fileInput.files || []);
    elements.fileInput.value = "";
  });
  elements.photoInput.addEventListener("change", () => {
    queueSelectedFiles("composer", elements.photoInput.files || []);
    elements.photoInput.value = "";
  });
  elements.newAttachButton.addEventListener("click", () => openAttachmentSource("new"));
  elements.newFileInput.addEventListener("change", () => {
    queueSelectedFiles("new", elements.newFileInput.files || []);
    elements.newFileInput.value = "";
  });
  elements.newPhotoInput.addEventListener("change", () => {
    queueSelectedFiles("new", elements.newPhotoInput.files || []);
    elements.newPhotoInput.value = "";
  });
  wireFileDrop(elements.composer, "composer");
  wireFileDrop(elements.newTaskForm, "new");
  elements.newModelSelect.addEventListener("change", () => syncEffortOptions(elements.newEffortSelect, elements.newModelSelect.value, ""));
  elements.recentTab.addEventListener("click", () => setListMode("recent"));
  elements.allHistoryTab.addEventListener("click", () => setListMode("all"));
  elements.archivedTab.addEventListener("click", () => setListMode("archived"));
  elements.refreshButton.addEventListener("click", () => {
    closeAllMenus();
    recoverVisibleState();
  });
  elements.loadMoreThreadsButton.addEventListener("click", () => {
    loadThreads({ silent: true, append: true }).catch((error) => showToast(error.message));
  });
  elements.threadSearch.addEventListener("input", debounce(() => {
    closeAllMenus();
    state.query = elements.threadSearch.value.trim();
    elements.clearSearchButton.classList.toggle("hidden", !state.query);
    loadThreads().catch((error) => showToast(error.message));
  }));
  elements.clearSearchButton.addEventListener("click", () => {
    closeAllMenus();
    elements.threadSearch.value = ""; state.query = ""; elements.clearSearchButton.classList.add("hidden");
    loadThreads().catch((error) => showToast(error.message));
  });
  elements.themeButton.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  elements.composer.addEventListener("submit", sendPrompt);
  elements.promptInput.addEventListener("input", () => {
    resizeComposer();
    scheduleDraftSave();
  });
  elements.promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); elements.composer.requestSubmit();
    }
  });
  elements.stopButton.addEventListener("click", stopTurn);
  elements.messages.addEventListener("scroll", () => {
    elements.scrollBottomButton.classList.toggle("hidden", shouldFollowOutput());
  });
  elements.scrollBottomButton.addEventListener("click", () => scrollToBottom(true));
  elements.loadMoreHistoryButton.addEventListener("click", loadMoreHistory);
  elements.loadCompleteHistoryButton.addEventListener("click", loadCompleteHistory);
  elements.historyNodesButton.addEventListener("click", openHistoryNodes);
  elements.closeHistoryNodesButton.addEventListener("click", () => elements.historyNodesDialog.close());
  elements.historyNodesLoadMoreButton.addEventListener("click", () => loadHistoryNodesPage().catch(() => {}));
  elements.historyNodesLoadAllButton.addEventListener("click", () => loadHistoryNodesPage({ all: true }).catch(() => {}));
  elements.historyNodesSearch.addEventListener("input", () => {
    elements.historyNodesList.scrollTop = 0;
    state.historyNodes.rangeStart = -1;
    state.historyNodes.rangeEnd = -1;
    renderHistoryNodes();
  });
  elements.historyNodesList.addEventListener("scroll", scheduleHistoryNodesRender, { passive: true });
  if (typeof ResizeObserver === "function") {
    const historyNodesResizeObserver = new ResizeObserver(() => {
      state.historyNodes.rangeStart = -1;
      state.historyNodes.rangeEnd = -1;
      scheduleHistoryNodesRender();
    });
    historyNodesResizeObserver.observe(elements.historyNodesList);
  }
  elements.historyNodesDialog.addEventListener("click", (event) => {
    if (event.target === elements.historyNodesDialog) elements.historyNodesDialog.close();
  });
  elements.contextButton.addEventListener("click", () => toggleContext());
  elements.closeContextButton.addEventListener("click", () => toggleContext(false));
  elements.changesTab.addEventListener("click", () => setContextTab("changes"));
  elements.infoTab.addEventListener("click", () => setContextTab("info"));
  elements.renameThreadButton.addEventListener("click", () => { elements.chatMenu.open = false; openRenameDialog(); });
  elements.pinThreadButton.addEventListener("click", () => { elements.chatMenu.open = false; if (state.selectedThread) togglePin(state.selectedThread.id); });
  elements.releaseThreadButton.addEventListener("click", () => {
    elements.chatMenu.open = false;
    stopLiveFollowing();
  });
  elements.archiveThreadButton.addEventListener("click", () => {
    elements.chatMenu.open = false;
    if (!state.selectedThread) return;
    if (state.selectedThread.archived) unarchiveThread(state.selectedThread.id); else archiveThread(state.selectedThread.id);
  });
  elements.goalThreadButton.addEventListener("click", () => {
    elements.chatMenu.open = false;
    openGoalDialog({ thread: state.selectedThread, goal: state.goal });
  });
  elements.closeThreadActionButton.addEventListener("click", () => elements.threadActionDialog.close());
  elements.actionPinThreadButton.addEventListener("click", () => {
    const id = state.threadActionTargetId;
    elements.threadActionDialog.close();
    if (id) togglePin(id);
  });
  elements.actionRenameThreadButton.addEventListener("click", () => {
    const thread = state.threads.find((item) => item.id === state.threadActionTargetId);
    elements.threadActionDialog.close();
    if (thread) openRenameDialog(thread);
  });
  elements.actionCopyThreadIdButton.addEventListener("click", async () => {
    const id = state.threadActionTargetId;
    elements.threadActionDialog.close();
    await copyThreadId(id);
  });
  elements.actionArchiveThreadButton.addEventListener("click", () => {
    const id = state.threadActionTargetId;
    elements.threadActionDialog.close();
    if (!id) return;
    if (state.threadActionTargetArchived) unarchiveThread(id); else archiveThread(id);
  });
  elements.threadActionDialog.addEventListener("click", (event) => {
    if (event.target === elements.threadActionDialog) elements.threadActionDialog.close();
  });
  elements.copyThreadIdButton.addEventListener("click", async () => {
    elements.chatMenu.open = false;
    await copyThreadId();
  });
  elements.closeConfirmButton.addEventListener("click", () => finishConfirmation(false));
  elements.cancelConfirmButton.addEventListener("click", () => finishConfirmation(false));
  elements.submitConfirmButton.addEventListener("click", () => finishConfirmation(true));
  elements.confirmDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishConfirmation(false);
  });
  elements.confirmDialog.addEventListener("close", () => {
    if (state.confirmResolver) finishConfirmation(false);
  });
  elements.closeRenameButton.addEventListener("click", () => elements.renameDialog.close());
  elements.renameForm.addEventListener("submit", renameThread);
  elements.modelChip.addEventListener("click", openSettingsDialog);
  elements.effortChip.addEventListener("click", openSettingsDialog);
  elements.closeSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
  elements.settingsForm.addEventListener("submit", saveSettings);
  elements.settingsModelSelect.addEventListener("change", () => syncEffortOptions(elements.settingsEffortSelect, elements.settingsModelSelect.value, ""));
  elements.closeGoalButton.addEventListener("click", () => elements.goalDialog.close());
  elements.goalForm.addEventListener("submit", saveGoal);
  for (const dialog of [elements.newTaskDialog, elements.renameDialog, elements.settingsDialog, elements.goalDialog, elements.deviceRenameDialog, elements.credentialsDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      if (dialog === elements.newTaskDialog && state.uploadRequest && state.uploadContext === "new") {
        showToast("请等待文件上传完成，或先取消上传");
        return;
      }
      dialog.close();
    });
  }
  document.addEventListener("pointerdown", closeOpenMenus, true);
  document.addEventListener("scroll", closeAllMenus, true);
  document.addEventListener("touchmove", closeAllMenus, { passive: true, capture: true });
  window.addEventListener("blur", closeAllMenus);
  window.addEventListener("resize", closeAllMenus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") closeAllMenus();
  });
  window.addEventListener("focus", recoverVisibleState);
  document.addEventListener("visibilitychange", recoverVisibleState);
  window.addEventListener("resize", () => queueViewportSync());
  window.addEventListener("orientationchange", () => queueViewportSync({ restore: true }));
  window.addEventListener("pageshow", () => queueViewportSync({ restore: true }));
  document.addEventListener("focusout", (event) => {
    // Moving between form controls should not reset the viewport mid-edit;
    // a null/non-form destination indicates that the keyboard was dismissed.
    const next = event.relatedTarget;
    if (next && /^(INPUT|TEXTAREA|SELECT)$/.test(next.tagName || "")) return;
    queueViewportSync({ restore: true });
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => queueViewportSync());
    window.visualViewport.addEventListener("scroll", () => syncViewportHeight());
  }
  window.addEventListener("offline", () => {
    if (!state.auth.authenticated) return;
    state.offlineSince ||= Date.now();
    stopEventConnection();
    setConnection("offline");
  });
  window.addEventListener("online", () => {
    if (!state.auth.authenticated) return;
    state.offlineSince = null;
    state.eventReconnectAttempt = 0;
    state.eventGeneration += 1;
    connectEvents({ generation: state.eventGeneration });
    runVisibleRecovery().catch(() => {});
  });
  window.addEventListener("popstate", () => {
    const threadId = routeThreadId();
    if (threadId) openThread(threadId, { updateRoute: false, archived: routeThreadArchived() }).catch((error) => showToast(error.message));
    else clearSelectedThread({ updateRoute: false });
  });
  window.addEventListener("beforeunload", () => saveThreadDraft(state.selectedThread?.id));
  setInterval(refreshVisibleState, 15_000);
  document.addEventListener("keydown", (event) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
    if (!typing && event.key.toLowerCase() === "n") openNewTaskDialog();
    if (event.key === "Escape") { closeAllMenus(); closeSidebar(); toggleContext(false); }
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  const registration = await navigator.serviceWorker.register("/sw.js");

  const offerUpdate = (worker) => {
    if (!worker || !navigator.serviceWorker.controller) return;
    showToast("新版界面已经准备好", 0, {
      label: "立即刷新",
      onClick: () => {
        state.updateRequested = true;
        worker.postMessage({ type: "SKIP_WAITING" });
      },
    });
  };

  if (registration.waiting) offerUpdate(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed") offerUpdate(worker);
    });
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (state.updateReloading || (!hadController && !state.updateRequested)) return;
    state.updateReloading = true;
    window.location.reload();
  });
}

async function startAuthenticatedApp() {
  if (state.appStarted) return;
  state.appStarted = true;
  try {
    await Promise.all([loadStatus(), loadThreads(), loadModels()]);
    const initialThreadId = routeThreadId();
    if (initialThreadId) await openThread(initialThreadId, { updateRoute: false, archived: routeThreadArchived() });
    connectEvents();
    const localNames = new Set(["localhost", "127.0.0.1", "::1"]);
    if (!window.isSecureContext && !localNames.has(window.location.hostname)) {
      showToast("当前是私网 HTTP：远程控制可用；完整安装和通知仍需 HTTPS", 5200);
    }
  } catch (error) {
    setConnection("error", error.message);
    showToast(error.message, 5200);
    connectEvents();
  }
}

async function initialize() {
  applyTheme(stored.theme);
  syncViewportHeight();
  wireEvents();
  registerServiceWorker().catch(() => {});
  try {
    const session = await api("/api/auth/session");
    showApplication(session);
    await startAuthenticatedApp();
  } catch (error) {
    showLogin(error.message === "请先登录 Codex Remote" ? "" : error.message);
  }
}

initialize();
