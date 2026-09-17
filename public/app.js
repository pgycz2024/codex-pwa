import { uiText } from "./ui-copy.js";
import { createTaskComposer } from "./task-composer.js";
import { createDiagnosticsView } from "./diagnostics-view.js";
import { createNotificationHandler } from "./notification-handler.js";
import { normalizeUserMessageText, reconcilePendingUserMessage } from "./message-reconcile.js";
import { filePreviewHref } from "./file-links.js";
import { formatUploadSize } from "./upload-utils.js";
import { readStoredStringArray } from "./storage-utils.js";
import {
  THREAD_TAGS_STORAGE_KEY,
  normalizeThreadTags,
  persistThreadTags as persistStoredThreadTags,
  readStoredThreadTags,
} from "./thread-tags.js";
import { createEventDeduper, persistEventId, readStoredEventId } from "./event-session.js";
import { boundedWindow, fixedVirtualRange } from "./virtual-list.js";
import { longReplyPresentation } from "./message-display.js";
import { installDialogFocus, canFocus, focusWithoutScroll } from "./dialog-focus.js";
import { createNavigationPanels } from "./navigation-panels.js";
import { createStatusAnnouncer } from "./status-announcer.js";
import { reconcileChildren, captureReadingAnchor, restoreReadingAnchor } from "./dom-reconcile.js";
import { formatAbsolute, formatRelative, formatTimestampMs, normalizeEpochSeconds } from "./time-display.js";
import {
  THREAD_LIST_MODES,
  THREAD_FILTERS,
  threadRecencyEpoch,
  isRecentThread,
  matchesThreadFilter,
} from "./thread-list.js";
import { buildActiveTaskSnapshot, readTaskSnapshot, reconcileTaskSnapshot, mergeTaskSnapshot } from "./task-snapshot.js";
import { threadStatusInfo as statusInfo, STATUS_LABELS, snapshotRecoveryMessage } from "./status-display.js";
import { createBrowserNotificationController } from "./browser-notifications.js";
import { createPushNotificationController } from "./push-notifications.js";
import { createMarkdownRenderer } from "./markdown-renderer.js";
import { createDeviceManager } from "./device-manager.js";
import { createAccessRootsManager } from "./access-roots.js";
import { createThreadActionsManager } from "./thread-actions.js";
import { createApprovalActionsManager } from "./approval-actions.js";
import { approvalRequestId, sameApprovalRequest } from "./approval-state.js";
import { createTaskSettingsManager } from "./task-settings.js";
import { createWriteRequestClient } from "./write-request.js";
import { resolveMessageTiming, displayedMessageTime, MESSAGE_TIME_SOURCES } from "./message-time.js";
import { createApiClient } from "./api-client.js";
import { createThreadApi } from "./thread-api.js";
import { createThreadListViewManager } from "./thread-list-view.js";
import { createHistoryNodesManager } from "./history-nodes.js";
import { createHistoryContextManager } from "./history-context.js";
import { createMessageViewManager } from "./message-view.js";
import { createDirectoryBrowserManager } from "./directory-browser.js";
import { createFileBrowserManager } from "./file-browser.js";
import { createActivityViewManager } from "./activity-view.js";
import { wireTabKeyboard } from "./tab-navigation.js";
import { createEventConnectionManager } from "./event-connection.js";
import { createGoalActionsManager } from "./goal-actions.js";
import { approvalCommand, approvalDetail, approvalFilePaths, approvalRisk, approvalFileContextNotice } from "./approval-policy.js";
import { APPROVAL_CHOICES, approvalDecisionIds, approvalDecisionNotice } from "./approval-decisions.js";
import {
  UNKNOWN_NOTIFICATION_STORAGE_KEY,
  readUnknownNotifications,
} from "./notification-diagnostics.js";
import {
  THREAD_VIEW_STATE_KEY,
  readThreadViewState,
  rememberThreadView,
  writeThreadViewState,
} from "./thread-view-state.js";
import {
  DIFF_CHUNK_SIZE,
  chronologicalTurns,
  countDiffLines,
  nextDiffChunkEnd,
  transcriptSignature,
} from "./history-utils.js";

const stored = {
  theme: localStorage.getItem("codex-pwa-theme") || "dark",
  model: localStorage.getItem("codex-pwa-model") || "",
  effort: localStorage.getItem("codex-pwa-effort") || "",
  permission: localStorage.getItem("codex-pwa-permission") || "request",
  legacyPins: readStoredStringArray(localStorage, "codex-pwa-pins"),
  lastDirectory: localStorage.getItem("codex-pwa-last-directory") || "",
};

stored.threadTags = readStoredThreadTags(localStorage);

const state = {
  roots: [],
  accessRoots: { configured: [], additional: [], roots: [], maxAdditionalRoots: 32 },
  rootAccessPolicy: null,
  appRoot: "",
  version: "",
  protocol: null,
  eventReplay: null,
  taskRecovery: null,
  unknownNotifications: readUnknownNotifications(localStorage, UNKNOWN_NOTIFICATION_STORAGE_KEY),
  threads: [],
  models: [],
  selectedThread: null,
  threadViewState: readThreadViewState(localStorage, THREAD_VIEW_STATE_KEY),
  activeTurnId: null,
  pendingComposerSends: new Set(),
  approvals: new Map(),
  approvalRevision: 0,
  statusLoadSequence: 0,
  itemNodes: new Map(),
  itemTurns: new Map(),
  itemText: new Map(),
  itemTimings: new Map(),
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
  threadFilter: "all",
  threadProjectFilter: "all",
  threadTagFilter: "all",
  threadTags: new Map(Object.entries(stored.threadTags)),
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
  tagTargetId: null,
  eventSource: null,
  eventGeneration: 0,
  eventReconnectTimer: null,
  eventReconnectAttempt: 0,
  eventHeartbeatTimer: null,
  eventLastHeartbeatAt: 0,
  eventRecoveryPending: false,
  eventRecoveryGap: false,
  eventRecoveryCount: 0,
  eventRecoveryTimer: null,
  lastEventId: readStoredEventId(sessionStorage),
  eventDeduper: createEventDeduper(),
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
  writeConflicts: new Map(),
  unreadThreads: new Set(readStoredUnreadThreads()),
  selectedThreadIds: new Set(),
  activeTaskSnapshot: readStoredActiveTaskSnapshot(),
  taskRecoveryNoticeShown: false,
  pendingFiles: [],
  newTaskFiles: [],
  pendingFilesThreadId: null,
  uploadRequest: null,
  uploadContext: null,
  uploadProgress: { loaded: 0, total: 0 },
  uploadPaused: false,
  browserUploadSession: null,
  uploadPreviewUrls: new Map(),
  streamRenderTimers: new Map(),
  streamFollowItems: new Set(),
  commandRenderTimers: new Map(),
  draftSaveTimer: null,
  threadViewSaveTimer: null,
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
    searchAllRoots: localStorage.getItem("codex-pwa-file-search-all") === "1",
    parent: null,
    roots: [],
    entries: [],
    truncated: false,
    searchMode: false,
    loadSequence: 0,
    loading: false,
    selectedPaths: new Set(),
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

let threadListViewManager = null;

const UNREAD_THREADS_STORAGE_KEY = "codex-pwa-unread-threads";
const ACTIVE_TASK_SNAPSHOT_STORAGE_KEY = "codex-pwa-active-task-snapshot";
let notificationController = null;
let pushNotificationController = null;

function readStoredUnreadThreads() {
  try {
    const value = JSON.parse(localStorage.getItem("codex-pwa-unread-threads") || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string" && id.length <= 160) : [];
  } catch {
    return [];
  }
}

function persistUnreadThreads() {
  try {
    localStorage.setItem(UNREAD_THREADS_STORAGE_KEY, JSON.stringify([...state.unreadThreads].slice(-500)));
  } catch {}
}

function readStoredActiveTaskSnapshot() {
  return readTaskSnapshot(localStorage, "codex-pwa-active-task-snapshot");
}

function syncActiveTaskSnapshot(threads) {
  const current = buildActiveTaskSnapshot(threads, (status) => statusInfo(status).type);
  const previous = state.activeTaskSnapshot;
  if (!state.taskRecoveryNoticeShown && previous.length) {
    const message = snapshotRecoveryMessage(reconcileTaskSnapshot(previous, current, threads));
    if (message) showToast(message, 9000);
  }
  state.taskRecoveryNoticeShown = true;
  state.activeTaskSnapshot = mergeTaskSnapshot(previous, current, threads);
  try {
    localStorage.setItem(ACTIVE_TASK_SNAPSHOT_STORAGE_KEY, JSON.stringify(state.activeTaskSnapshot));
  } catch {}
}

const elementIds = [
  "appShell", "authGate", "loginForm", "loginUsername", "loginPassword", "rememberDevice",
  "loginError", "loginButton", "changeCredentialsLoginButton", "logoutButton", "logoutAllButton", "refreshWebUiButton", "serverFilesButton", "trustedDevicesButton",
  "instanceName", "networkLabel",
  "notificationDialog", "notificationStatus", "closeNotificationButton", "enablePageNotificationButton", "enablePushButton", "disablePushButton",
  "sidebar", "sidebarBackdrop", "closeSidebarButton", "menuButton", "newTaskButton",
  "emptyNewTaskButton", "threadSearch", "clearSearchButton", "recentTab", "allHistoryTab", "threadFilter", "threadProjectFilter", "threadTagFilter", "threadBatchActions", "selectVisibleThreadsButton", "markSelectedThreadsReadButton", "archiveSelectedThreadsButton", "clearSelectedThreadsButton",
  "archivedTab", "refreshButton", "threadList", "loadMoreThreadsButton", "themeButton", "themeIcon", "themeLabel", "helpButton", "notificationButton", "notificationLabel",
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
  "fileBrowserSearchAll",
  "fileBrowserLimitNotice", "fileBrowserUploadStatus", "fileBrowserUploadInput", "uploadToDirectoryButton", "pauseFileBrowserUploadButton", "newFileBrowserFolderButton",
  "manageAccessRootsButton", "refreshFileBrowserButton", "copySelectedFilesButton", "moveSelectedFilesButton", "deleteSelectedFilesButton", "newTaskFromDirectoryButton",
  "accessRootsDialog", "closeAccessRootsButton", "accessRootsList", "accessRootForm", "accessRootPath",
  "devicesDialog", "closeDevicesButton", "devicesList", "refreshDevicesButton", "logoutOtherDevicesButton", "changeCredentialsButton",
  "credentialsDialog", "credentialsForm", "closeCredentialsButton", "currentUsernameInput", "currentPasswordInput", "newUsernameInput", "newPasswordInput", "confirmNewPasswordInput", "credentialsError", "saveCredentialsButton",
  "threadActionDialog", "threadActionTitle", "closeThreadActionButton", "actionPinThreadButton",
  "actionRenameThreadButton", "actionCopyThreadIdButton", "actionArchiveThreadButton", "confirmDialog",
  "confirmEyebrow", "confirmTitle", "confirmMessage", "closeConfirmButton", "cancelConfirmButton",
  "submitConfirmButton", "helpDialog", "closeHelpButton", "helpQuestionInput", "askWebUiButton",
  "requestUiChangeButton", "deviceRenameDialog", "deviceRenameForm",
  "closeDeviceRenameButton", "deviceRenameInput",
  "newEffortSelect", "newPermissionSelect", "renameDialog", "renameForm", "tagDialog", "tagForm", "closeTagButton", "tagInput",
  "closeRenameButton", "renameInput", "settingsDialog", "settingsForm", "closeSettingsButton",
  "settingsModelSelect", "settingsEffortSelect", "settingsPermissionSelect", "settingsPendingHint", "goalDialog", "goalForm",
  "goalDialogTitle", "goalObjectiveInput", "goalBudgetInput", "goalStatusInput", "goalDialogHint", "closeGoalButton",
  "newGoalDetails", "newGoalObjective", "newGoalBudget", "historyNodesDialog", "closeHistoryNodesButton",
  "historyNodesSearch", "historyNodesStatus", "historyNodesLoading", "historyNodesList", "historyNodesCanvas", "historyNodesRows",
  "historyNodesLoadMoreButton", "historyNodesLoadAllButton",
  "offlineBanner", "toast", "writeQueueStatus",
];
const elements = Object.fromEntries(elementIds.map((id) => [id, document.getElementById(id)]));

const api = createApiClient({
  getAuth: () => state.auth,
  setConnection,
  onUnauthorized: (message) => showLogin(message),
});
const threadApi = createThreadApi({ api });

const writeRequests = createWriteRequestClient({ api, onChange: renderWriteQueueStatus });

const {
  openDeviceRename,
  openCredentialsDialog,
  saveCredentials,
  renderDevices,
  loadDevices,
  openDevices,
  renameDevice,
  logoutOtherDevices,
} = createDeviceManager({
  state,
  elements,
  api,
  el,
  closeAllMenus,
  closeSidebar,
  requestConfirmation,
  showToast,
  showLogin,
  showLoadingToast,
  finishLoadingToast,
  formatTimestampMs,
});

const {
  renderAccessRoots,
  openAccessRoots,
  addAccessRoot,
  removeAccessRoot,
} = createAccessRootsManager({
  state,
  elements,
  api,
  el,
  basename,
  closeAllMenus,
  requestConfirmation,
  showToast,
  loadStatus,
});

const {
  openRenameDialog,
  openThreadActionMenu,
  togglePin,
  renameThread,
  markSelectedThreadsRead,
  archiveSelectedThreads,
  archiveThread,
  unarchiveThread,
} = createThreadActionsManager({
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
});

threadListViewManager = createThreadListViewManager({
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
});

const { answerApproval, answerQuestion, submissionState } = createApprovalActionsManager({
  state,
  elements,
  writeRequests,
  requestConfirmation,
  confirmationPreview,
  approvalDetail,
  renderApprovals,
  markThreadWriteConflict,
  refreshSelectedThread,
  refreshApprovals: loadStatus,
  showToast,
});

const {
  modelFor,
  effortLabel,
  permissionLabels,
  settingsState,
  applyEffectiveSettings,
  commitEffectiveSettings,
  displayedSettings,
  pendingSettings,
  hasPendingSettings,
  syncEffortOptions,
  syncSettingsControls,
  updateOptionChips,
  loadModels,
} = createTaskSettingsManager({
  state,
  elements,
  api,
  el,
  renderInfoPanel,
});

const {
  applyGoalState,
  renderGoalBar,
  loadThreadGoal,
  setGoalStatus,
  clearGoal,
  openGoalDialog,
  saveGoal,
} = createGoalActionsManager({
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
});

const announceStatus = createStatusAnnouncer();
const eventConnection = createEventConnectionManager({
  state,
  sessionStorageRef: sessionStorage,
  environment: globalThis,
  setConnection,
  runVisibleRecovery,
  showToast,
  persistEventId,
  handleNotification,
  markThreadUnread,
  updateThreadStatus,
  sendBrowserNotification,
  announceStatus,
  renderApprovals,
  updateChatActions,
  updateTurnControls,
  renderAccessRoots,
  renderInfoPanel,
  isQuestionRequest,
});
const stopEventConnection = eventConnection.stop;
const scheduleEventReconnect = eventConnection.schedule;
const connectEvents = eventConnection.connect;

const navigationPanels = createNavigationPanels({ sidebar: elements.sidebar, contextPanel: elements.contextPanel,
  sidebarTrigger: elements.menuButton, contextTrigger: elements.contextButton,
  backdrop: elements.sidebarBackdrop, scope: elements.appShell });
installDialogFocus([
  elements.notificationDialog,
  elements.newTaskDialog,
  elements.directoryDialog,
  elements.fileBrowserDialog,
  elements.accessRootsDialog,
  elements.devicesDialog,
  elements.credentialsDialog,
  elements.threadActionDialog,
  elements.confirmDialog,
  elements.helpDialog,
  elements.historyNodesDialog,
  elements.deviceRenameDialog,
  elements.renameDialog,
  elements.tagDialog,
  elements.settingsDialog,
  elements.goalDialog,
  elements.attachmentSourceDialog,
], { fallbackFocus: () => canFocus(elements.menuButton) ? elements.menuButton : elements.promptInput });

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
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

const {
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
} = createHistoryNodesManager({
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
  maxNodes: MAX_RETAINED_HISTORY_NODES,
  maxNodeTextChars: MAX_HISTORY_NODE_TEXT_CHARS,
  rowHeight: 74,
});

const {
  historyContextBanner,
  updateHistoryContextBanner,
  markHistoryContextUpdated,
  historyContextBoundary,
  historyContextTurn,
  renderHistoryWindow,
  shiftHistoryWindow,
} = createHistoryContextManager({
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
  renderKnownArtifacts: (...args) => renderKnownArtifacts(...args),
  updateHistoryControls,
  scrollToBottom,
});

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
    remove.setAttribute("aria-label", uiText("app.renderUploadQueue.setAttribute", file.name));
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
      el("span", "", uiText("app.renderUploadQueue.el", files.length)),
      el("span", "", total > 0 ? `${percent}%` : formatUploadSize(loaded)),
    );
    const cancel = el("button", "upload-cancel", uiText("common.cancel"));
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
      rejected = uiText("app.queueSelectedFiles.text2");
      break;
    }
    if (file.size > MAX_UPLOAD_FILE_SIZE) {
      rejected = uiText("app.queueSelectedFiles.text", file.name);
      continue;
    }
    if (totalSize + file.size > MAX_UPLOAD_BATCH_SIZE) {
      rejected = uiText("files.uploadFilesToBrowserDirectory.showToast");
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
  if (state.uploadRequest) return Promise.reject(new Error(uiText("common.uploadBusy")));

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
      else reject(new Error(payload.error || uiText("files.startBrowserDirectoryUpload.showToast2", request.status)));
    });
    request.addEventListener("error", () => { cleanup(); reject(new Error(uiText("common.uploadDisconnected"))); });
    request.addEventListener("abort", () => { cleanup(); reject(new Error(uiText("common.uploadCancelled"))); });
    request.send(form);
  });
}

function showToast(message, duration = 3600, action = null) {
  announceStatus(message);
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

function browserNotificationsAvailable() {
  return Boolean(notificationController?.available());
}

function syncNotificationControl() {
  notificationController?.sync(elements.notificationButton, elements.notificationLabel);
}

async function enableBrowserNotifications() {
  pushNotificationController?.open();
}

function sendBrowserNotification({ threadId, title, body }) {
  return notificationController?.send({ threadId, title, body });
}

function dismissToast() {
  state.loadingToastToken = 0;
  elements.toast.classList.remove("loading");
  clearTimeout(showToast.timer);
  showToast.timer = null;
  elements.toast.classList.add("hidden");
  elements.toast.replaceChildren();
}

function showLoadingToast(message = uiText("html.historyNodesLoading.text")) {
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

function requestConfirmation({ title, message, confirmLabel = uiText("common.confirm"), danger = false, eyebrow = uiText("common.confirmAction") }) {
  closeAllMenus();
  if (state.confirmResolver) finishConfirmation(false);
  elements.confirmEyebrow.textContent = eyebrow;
  elements.confirmEyebrow.lang = /^[\x00-\x7F]+$/.test(String(eyebrow || "").trim()) ? "en" : "zh-CN";
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
  const value = elements.promptInput.value;
  state.draftSaveTimer = setTimeout(() => saveThreadDraft(threadId, value), 220);
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

function messageTime(epochSeconds) {
  const normalized = normalizeEpochSeconds(epochSeconds);
  if (!normalized) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(normalized * 1000));
}

function storeItemTiming(itemId, timing) {
  if (!itemId) return;
  state.itemTimings.set(itemId, timing);
  while (state.itemTimings.size > 4096) state.itemTimings.delete(state.itemTimings.keys().next().value);
}

function applyMessageTiming(row, itemId, timing, role) {
  storeItemTiming(itemId, timing);
  const point = displayedMessageTime(timing, role);
  setMessageTimestamp(row, point.timestamp, { ...point, timing });
}

function setMessageTimestamp(row, timestamp, { estimated = false, source = "", timing = {} } = {}) {
  if (!row) return;
  let meta = row.querySelector(".message-meta");
  const normalized = normalizeEpochSeconds(timestamp);
  if (!normalized) {
    meta?.remove();
    return;
  }
  if (!meta) {
    meta = el("time", "message-meta");
    row.append(meta);
  }
  const time = messageTime(normalized);
  meta.textContent = estimated ? `约 ${time}` : time;
  meta.title = `${time}（${MESSAGE_TIME_SOURCES[source] || "消息时间"}）`;
  meta.dataset.source = source;
  for (const [field, label] of [["sentAt", "发送"], ["startedAt", "开始"], ["completedAt", "完成"]]) {
    const point = timing[field];
    if (point?.value) {
      meta.dataset[field] = new Date(point.value * 1000).toISOString();
      meta.title += `\n${label}：${messageTime(point.value)}（${MESSAGE_TIME_SOURCES[point.source]}）`;
    } else delete meta.dataset[field];
  }
  meta.dateTime = new Date(normalized * 1000).toISOString();
  meta.setAttribute("aria-label", meta.title);
  meta.setAttribute("datetime", meta.dateTime);
  meta.dataset.estimated = estimated ? "true" : "false";
}

function refreshRelativeTimes() {
  for (const time of document.querySelectorAll(".thread-time[data-epoch]")) {
    const epoch = normalizeEpochSeconds(time.dataset.epoch);
    if (!epoch) continue;
    time.textContent = formatRelative(epoch);
    time.title = formatAbsolute(epoch);
  }
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
  const previousLabel = elements.connectionLabel.textContent;
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
  if (previousLabel !== elements.connectionLabel.textContent) announceStatus(elements.connectionLabel.textContent);
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
  navigationPanels.sidebar(true);
}

function closeSidebar() {
  closeAllMenus();
  navigationPanels.sidebar(false);
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

function syncListModeTabs(...args) {
  return threadListViewManager?.syncListModeTabs(...args);
}

function syncProjectFilterOptions(...args) {
  return threadListViewManager?.syncProjectFilterOptions(...args);
}

function syncTagFilterOptions(...args) {
  return threadListViewManager?.syncTagFilterOptions(...args);
}

function visibleThreadCandidates(...args) {
  return threadListViewManager?.visibleThreadCandidates(...args) || [];
}

function syncThreadBatchActions(...args) {
  return threadListViewManager?.syncThreadBatchActions(...args);
}

function toggleThreadSelection(...args) {
  return threadListViewManager?.toggleThreadSelection(...args);
}

function renderThreads(...args) {
  return threadListViewManager?.renderThreads(...args);
}

function setListMode(mode) {
  const normalized = THREAD_LIST_MODES.has(mode) ? mode : "recent";
  closeAllMenus();
  state.selectedThreadIds.clear();
  state.threadListMode = normalized;
  syncListModeTabs();
  state.threadCursor = null;
  loadThreads().catch((error) => showToast(error.message));
}

function setThreadFilter(filter) {
  const normalized = THREAD_FILTERS.has(filter) ? filter : "all";
  state.threadFilter = normalized;
  if (elements.threadFilter.value !== normalized) elements.threadFilter.value = normalized;
  renderThreads();
}

function setThreadProjectFilter(project) {
  state.threadProjectFilter = project && project !== "all" ? String(project) : "all";
  state.selectedThreadIds.clear();
  syncProjectFilterOptions();
  renderThreads();
}

function tagsForThread(threadId) {
  return state.threadTags.get(String(threadId)) || [];
}

function persistThreadTags() {
  persistStoredThreadTags(localStorage, state.threadTags);
}

function setThreadTagFilter(tag) {
  state.threadTagFilter = tag && tag !== "all" ? String(tag) : "all";
  state.selectedThreadIds.clear();
  syncTagFilterOptions();
  renderThreads();
}

function openTagDialog(thread = state.selectedThread) {
  if (!thread) return;
  state.tagTargetId = thread.id;
  elements.tagInput.value = tagsForThread(thread.id).join(", ");
  elements.tagDialog.showModal();
  setTimeout(() => elements.tagInput.select(), 40);
}

function saveThreadTags(event) {
  event.preventDefault();
  if (!state.tagTargetId) return;
  const tags = normalizeThreadTags(elements.tagInput.value);
  if (tags.length) state.threadTags.set(state.tagTargetId, tags);
  else state.threadTags.delete(state.tagTargetId);
  persistThreadTags();
  syncTagFilterOptions();
  renderThreads();
  elements.tagDialog.close();
  showToast(tags.length ? uiText("app.saveThreadTags.showToast2") : uiText("app.saveThreadTags.showToast"));
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
  popover.setAttribute("aria-label", anchor.getAttribute("aria-label") || "操作");
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
    control.tabIndex = -1;
    control.addEventListener("click", () => {
      if (action.href) setTimeout(closeAllMenus, 0);
      else closeAllMenus();
      action.handler?.();
    });
    popover.append(control);
  }
  anchor.setAttribute("aria-expanded", "true");
  owner?.classList.add("menu-open");
  state.floatingMenu = { anchor, owner, element: popover, anchorRect: anchor.getBoundingClientRect() };
  popover.style.visibility = "hidden";
  const host = anchor.closest('dialog[open], [aria-modal="true"]') || document.body;
  host.append(popover);
  if (typeof popover.showPopover === "function") {
    popover.popover = "manual";
    popover.showPopover();
  }
  popover.addEventListener("keydown", (event) => {
    const items = [...popover.querySelectorAll('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    if (event.key === "Home") next = items[0];
    if (event.key === "End") next = items.at(-1);
    if (next) {
      event.preventDefault();
      items.forEach((item) => { item.tabIndex = item === next ? 0 : -1; });
      focusWithoutScroll(next);
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
      closeFloatingMenu();
    }
  });
  requestAnimationFrame(() => {
    if (state.floatingMenu?.element !== popover) return;
    positionFloatingMenu(state.floatingMenu);
    const first = popover.querySelector('[role="menuitem"]');
    if (first) { first.tabIndex = 0; focusWithoutScroll(first); }
  });
}

function markThreadUnread(threadId) {
  if (!threadId || (state.selectedThread?.id === threadId && document.visibilityState !== "hidden")) return;
  state.unreadThreads.add(threadId);
  persistUnreadThreads();
  renderThreads();
}

function clearThreadUnread(threadId) {
  if (!threadId || !state.unreadThreads.delete(threadId)) return;
  persistUnreadThreads();
  renderThreads();
}

async function loadThreads({ silent = false, append = false, isCurrent = () => true } = {}) {
  if (append && (!state.threadCursor || state.threadsLoadingMore)) return;
  const sequence = ++state.threadLoadSequence;
  if (!silent || append) closeAllMenus();
  elements.threadList.setAttribute("aria-busy", "true");
  if (!silent && !append && !elements.threadList.querySelector(".thread-card")) {
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
    const result = await threadApi.list(params);
    if (sequence !== state.threadLoadSequence || !isCurrent()) return false;
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
    syncActiveTaskSnapshot(state.threads);
    return true;
  } finally {
    if (sequence === state.threadLoadSequence) {
      elements.threadList.setAttribute("aria-busy", "false");
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
  if (!state.auth.authenticated || document.visibilityState === "hidden" || navigator.onLine === false) return false;
  if (state.visibleRecoveryPromise) return state.visibleRecoveryPromise;
  const selectedId = state.selectedThread?.id;
  const generation = state.eventGeneration;
  const source = state.eventSource;
  const isCurrent = () => state.auth.authenticated && document.visibilityState !== "hidden" && navigator.onLine !== false
    && generation === state.eventGeneration && source === state.eventSource;
  const task = (async () => {
    // Reconcile the global snapshot first. Opening the selected thread then
    // becomes the newest, authoritative view of its active writer state.
    const results = await Promise.all([loadStatus({ isCurrent }), loadThreads({ silent: true, isCurrent })]);
    if (!isCurrent() || results.some((result) => result !== true) || state.selectedThread?.id !== selectedId) return false;
    if (selectedId) {
      if (await openThread(selectedId, { silent: true, preserveScroll: true, isCurrent }) !== true) return false;
    }
    return isCurrent();
  })().finally(() => {
    if (state.visibleRecoveryPromise === task) state.visibleRecoveryPromise = null;
  });
  state.visibleRecoveryPromise = task;
  return task;
}

const recoverVisibleState = debounce(() => {
  if (navigator.onLine === false) return;
  void eventConnection.recover();
}, 260);

function clearSelectedThread({ updateRoute = true } = {}) {
  clearTimeout(state.draftSaveTimer);
  saveThreadDraft(state.selectedThread?.id);
  clearStreamingRenderTimers();
  if (state.uploadContext !== "browser") state.uploadRequest?.abort();
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
  state.itemTimings.clear();
  state.transcriptSignatures.clear();
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
  elements.chatMeta.textContent = uiText("app.openThread.textContent");
  elements.chatMeta.removeAttribute("title");
  elements.chatMeta.removeAttribute("aria-label");
  updateTurnControls();
  updateChatActions();
  if (updateRoute) updateThreadRoute(null);
}

const { renderMarkdown } = createMarkdownRenderer({ getRoots: () => state.roots });

const {
  activityCard,
  statusLabel,
  commandTitle,
  collapsedLongText,
  boundedLiveText,
  appendBoundedLiveText,
  paintExpandableOutput,
  toggleCommandOutput,
  scheduleCommandOutputRender,
  renderCommand,
  updateCommandMeta,
  renderDiff,
  attachLazyDiff,
  kindLabel,
  collectFileChanges,
  renderFileChange,
  renderTool,
  renderReasoning,
  renderPlan,
  renderActivity,
  isContextNotice,
  notificationTurnId,
  renderTurnNotice,
  imageArtifactMetadata,
  renderImageGeneration,
  suppressRedundantGeneratedArtifacts,
  renderKnownArtifacts,
} = createActivityViewManager({
  state,
  elements,
  el,
  threadApi,
  showToast,
  scrollToBottom,
  renderChangesPanel,
  turnGroup,
  placeNodeInContainer,
  nextDiffChunkEnd,
  countDiffLines,
  diffChunkSize: DIFF_CHUNK_SIZE,
  commandOutputPreviewChars: COMMAND_OUTPUT_PREVIEW_CHARS,
  toolOutputPreviewChars: TOOL_OUTPUT_PREVIEW_CHARS,
  maxLiveTextChars: MAX_LIVE_TEXT_CHARS,
  maxLiveCommandChars: MAX_LIVE_COMMAND_CHARS,
  liveTextTruncationMarker: LIVE_TEXT_TRUNCATION_MARKER,
  formatUploadSize,
  streamRenderIntervalMs: STREAM_RENDER_INTERVAL_MS,
});

const {
  renderUserMessage,
  renderAssistantBody,
  ensureAssistantCopyAction,
  renderOptimisticUserMessage,
  assignOptimisticMessageTurn,
  discardOptimisticMessage,
  renderAssistantMessage,
  scheduleAssistantMessageRender,
} = createMessageViewManager({
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
  streamRenderInterval: STREAM_RENDER_INTERVAL_MS,
});

const {
  renderDirectoryRoots,
  renderDirectoryBreadcrumbs,
  createDirectoryEntry,
  renderDirectoryList,
  setDirectoryLoading,
  loadDirectory,
  closeDirectoryBrowser,
  openDirectoryBrowser,
  chooseCurrentDirectory,
  selectServerDirectory,
  createNewDirectory,
} = createDirectoryBrowserManager({
  state,
  elements,
  stored,
  api,
  el,
  basename,
  pathWithinDirectory,
  closeAllMenus,
  requestConfirmation,
  showToast,
  showLoadingToast,
  finishLoadingToast,
  formatUploadSize,
  localStorage,
});

const {
  renderFileBrowserRoots,
  syncFileSelectionControls,
  createFileBrowserEntry,
  deleteSelectedFileBrowserEntries,
  operateSelectedFileBrowserEntries,
  operateFileBrowserEntry,
  createFileBrowserFolder,
  uploadFilesToBrowserDirectory,
  syncBrowserUploadControls,
  clearBrowserUploadSession,
  pauseBrowserDirectoryUpload,
  startBrowserDirectoryUpload,
  syncFileBrowserUploadProgress,
  renderFileBrowserList,
  setFileBrowserLoading,
  loadFileBrowser,
  openFileBrowser,
  closeFileBrowser,
} = createFileBrowserManager({
  state,
  elements,
  api,
  el,
  basename,
  pathWithinDirectory,
  closeAllMenus,
  closeSidebar,
  openFloatingMenu,
  requestConfirmation,
  confirmationPreview,
  copyText,
  filePreviewHref,
  formatTimestampMs,
  formatUploadSize,
  showToast,
  showLoadingToast,
  finishLoadingToast,
  selectServerDirectory,
  localStorage,
  maxUploadFileSize: MAX_UPLOAD_FILE_SIZE,
  maxUploadBatchSize: MAX_UPLOAD_BATCH_SIZE,
});

function shouldFollowOutput() {
  return elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 150;
}

function scrollToBottom(force = false) {
  if (force || shouldFollowOutput()) elements.messages.scrollTop = elements.messages.scrollHeight;
}

function rememberSelectedThreadView() {
  const threadId = state.selectedThread?.id;
  if (!threadId) return;
  const range = Math.max(0, elements.messages.scrollHeight - elements.messages.clientHeight);
  const ratio = range ? elements.messages.scrollTop / range : 1;
  state.threadViewState = rememberThreadView(state.threadViewState, threadId, {
    ratio,
    bottom: shouldFollowOutput(),
  });
  writeThreadViewState(localStorage, state.threadViewState, THREAD_VIEW_STATE_KEY);
}

function scheduleSelectedThreadViewSave() {
  clearTimeout(state.threadViewSaveTimer);
  state.threadViewSaveTimer = setTimeout(() => {
    state.threadViewSaveTimer = null;
    rememberSelectedThreadView();
  }, 180);
}

function restoreSelectedThreadView(threadId) {
  const saved = state.threadViewState[threadId];
  if (!saved || saved.bottom) return false;
  const range = Math.max(0, elements.messages.scrollHeight - elements.messages.clientHeight);
  elements.messages.scrollTop = Math.min(range, Math.max(0, range * saved.ratio));
  return true;
}

function createMessageRow(role) {
  const row = el("article", `message-row ${role}`);
  row.setAttribute("aria-label", role === "user" ? "用户消息" : role === "assistant" ? "Codex 回复" : "后台活动");
  if (role !== "user") row.append(el("div", "message-avatar", role === "assistant" ? "C" : "i"));
  const body = el("div", "message-body");
  row.append(body);
  return { row, body };
}

function clearOutcomeUnknown(row) {
  if (!row?.classList.contains("outcome-unknown") && row?.dataset.outcomeUnknown !== "true") return;
  row.classList.remove("outcome-unknown");
  delete row.dataset.outcomeUnknown;
  if (row.title === "服务器尚未确认接收结果；请等待自动刷新核对") row.removeAttribute("title");
}

function turnGroup(turnId, { create = false } = {}) {
  if (!turnId) return null;
  let group = [...elements.messages.querySelectorAll(".turn-group")]
    .find((candidate) => candidate.dataset.turnId === turnId);
  if (!group && create) {
    group = el("section", "turn-group");
    group.dataset.turnId = turnId;
    group.setAttribute("aria-busy", "true");
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

async function loadThreadArtifacts(threadId) {
  if (!threadId) return;
  const sequence = ++state.artifactLoadSequence;
  const result = await threadApi.artifacts(threadId);
  if (sequence !== state.artifactLoadSequence || state.selectedThread?.id !== threadId) return;
  state.artifacts.clear();
  for (const artifact of result.data || []) state.artifacts.set(artifact.id, artifact);
  renderKnownArtifacts();
}

function renderItem(item, container = elements.messages, options = {}) {
  const row = renderItemContent(item, container, options);
  if (row && item?.id) row.dataset.itemId = item.id;
  return row;
}

function renderItemContent(item, container = elements.messages, options = {}) {
  if (!item) return null;
  if (item.id && options.turnId) state.itemTurns.set(item.id, options.turnId);
  if (item.type === "userMessage") return renderUserMessage(item, container, options);
  if (item.type === "agentMessage") {
    const bounded = boundedLiveText(item.text || "");
    state.itemText.set(item.id, bounded.text);
    return renderAssistantMessage(item.id, bounded.text, options.timeEvent?.phase === "started" || item.status === "inProgress", container, { ...options, item });
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
    elements.loadMoreHistoryButton.textContent = uiText("app.updateHistoryControls.textContent7");
    elements.loadCompleteHistoryButton.classList.remove("hidden");
    elements.loadCompleteHistoryButton.disabled = true;
    elements.loadCompleteHistoryButton.textContent = uiText("app.updateHistoryControls.textContent6");
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
      ? uiText("app.updateHistoryControls.textContent4")
      : hasMore ? uiText("html.loadMoreHistoryButton.text") : uiText("app.updateHistoryControls.textContent5");
    elements.loadCompleteHistoryButton.classList.remove("hidden");
    elements.loadCompleteHistoryButton.disabled = loading || !hasMore;
    elements.loadCompleteHistoryButton.textContent = state.historyCompleteLoading
      ? uiText("app.updateHistoryControls.textContent3")
      : hasMore ? uiText("html.loadCompleteHistoryButton.text") : uiText("app.updateHistoryControls.textContent2");
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
    ? uiText("app.updateHistoryControls.textContent4")
    : uiText("html.loadMoreHistoryButton.text");
  elements.loadCompleteHistoryButton.classList.toggle("hidden", state.historyComplete && !state.historyCompleteLoading);
  elements.loadCompleteHistoryButton.disabled = state.historyCompleteLoading;
  elements.loadCompleteHistoryButton.textContent = state.historyCompleteLoading
    ? uiText("app.updateHistoryControls.textContent3")
    : state.historyComplete
      ? uiText("app.updateHistoryControls.textContent2")
      : state.historyCompleteStarted ? uiText("app.updateHistoryControls.textContent") : uiText("html.loadCompleteHistoryButton.text");
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
  showToast(uiText("app.markHistoryMemoryLimited.showToast"), 7000);
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

function retryTurnPrompt(turn) {
  const prompt = historyNodePrompt(turn);
  if (!prompt) {
    showToast("这个失败轮次没有可恢复的用户输入", 4200);
    return;
  }
  elements.promptInput.value = prompt;
  resizeComposer();
  scheduleDraftSave();
  elements.promptInput.focus();
  showToast("原消息已恢复到输入框，请确认后重新发送", 4200);
}

function createTurnOutcome(turn) {
  if (turn?.status === "failed") {
    const outcome = el("div", "turn-error");
    outcome.append(el("span", "turn-error-copy", turn.error?.message || "任务执行失败"));
    const prompt = historyNodePrompt(turn);
    if (prompt) {
      const retry = el("button", "turn-retry", "重试此消息");
      retry.type = "button";
      retry.addEventListener("click", () => retryTurnPrompt(turn));
      outcome.append(retry);
    }
    outcome.dataset.turnOutcome = turn.status;
    outcome.setAttribute("role", "alert");
    return outcome;
  }
  if (turn?.status === "interrupted") {
    const outcome = el("div", "turn-divider");
    outcome.append(el("span", "turn-divider-label", STATUS_LABELS.interrupted));
    const prompt = historyNodePrompt(turn);
    if (prompt) {
      const resume = el("button", "turn-resume", "继续此消息");
      resume.type = "button";
      resume.addEventListener("click", () => retryTurnPrompt(turn));
      outcome.append(resume);
    }
    outcome.dataset.turnOutcome = turn.status;
    outcome.setAttribute("role", "status");
    return outcome;
  }
  return null;
}

const turnOutcomeKeys = new WeakMap();

function syncTurnOutcome(group, turn) {
  if (!group) return;
  group.setAttribute("aria-busy", String(turn?.status === "inProgress"));
  const key = JSON.stringify([turn?.status, turn?.error?.message, historyNodePrompt(turn)]);
  if (turnOutcomeKeys.get(group) === key) return;
  turnOutcomeKeys.set(group, key);
  group.querySelector("[data-turn-outcome]")?.remove();
  const outcome = createTurnOutcome(turn);
  if (outcome) group.append(outcome);
}

function createTurnGroup(turn) {
  const group = el("section", "turn-group");
  group.dataset.turnId = turn.id || "";
  group.tabIndex = -1;
  updateTurnGroup(group, turn);
  return group;
}

function dropRenderedItem(itemId) {
  state.itemNodes.get(itemId)?.element?.remove();
  state.itemNodes.delete(itemId);
  state.itemTurns.delete(itemId);
  state.itemText.delete(itemId);
  for (const timers of [state.streamRenderTimers, state.commandRenderTimers]) {
    clearTimeout(timers.get(itemId));
    timers.delete(itemId);
  }
  state.streamFollowItems.delete(itemId);
}

function updateTurnGroup(group, turn, { replaceItems = true } = {}) {
  const active = document.activeElement;
  const hadFocus = group.contains(active);
  const itemIds = new Set((turn.items || []).map((item) => item.id).filter(Boolean));
  if (replaceItems) for (const [itemId, node] of state.itemNodes) {
    if (!group.contains(node.element) || itemIds.has(itemId) || String(itemId).startsWith("local-") || state.artifacts.has(itemId)) continue;
    dropRenderedItem(itemId);
  }
  const children = (turn.items || []).map((item) => renderItem(item, group, { collectChanges: false, turnId: turn.id, turn })).filter(Boolean);
  const extras = [...group.children].filter((node) => !children.includes(node) && !node.dataset.turnOutcome
    && (!replaceItems || node.classList.contains("optimistic") || state.artifacts.has(node.dataset.artifactId)));
  syncTurnOutcome(group, turn);
  const outcome = group.querySelector("[data-turn-outcome]");
  reconcileChildren(group, [...new Set([...children, ...extras, ...(outcome ? [outcome] : [])])]);
  if (hadFocus && !active.isConnected && group.isConnected) group.focus({ preventScroll: true });
  if (turn.status === "inProgress") state.activeTurnId = turn.id;
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

function mergeActiveTranscript(turn, { force = false } = {}) {
  if (!turn?.id) return false;
  const signature = transcriptSignature(turn);
  if (!force && signature !== null && state.transcriptSignatures.get(turn.id) === signature) return false;
  state.transcriptSignatures.delete(turn.id);
  if (signature !== null) state.transcriptSignatures.set(turn.id, signature);
  while (state.transcriptSignatures.size > 8) state.transcriptSignatures.delete(state.transcriptSignatures.keys().next().value);
  mergeTurnsPage([turn], { replaceItems: true });
  return true;
}

async function restoreActiveTranscript(threadId, turnId, { force = false, follow = false } = {}) {
  if (!threadId || !turnId) return;
  const key = `${threadId}:${turnId}`;
  if (state.transcriptLoads.has(key)) return state.transcriptLoads.get(key);
  const task = (async () => {
    const wasFollowing = follow || shouldFollowOutput();
    const result = await threadApi.transcript(threadId, turnId);
    if (state.selectedThread?.id !== threadId || state.activeTurnId !== turnId) return;
    if (!canRetainHistoryPage([result.turn])) {
      markHistoryMemoryLimited();
      return;
    }
    const anchor = captureReadingAnchor(elements.messages, [...elements.messages.querySelectorAll(".message-row, .activity-card")]);
    const changed = mergeActiveTranscript(result.turn, { force });
    if (!changed) return;
    if (!wasFollowing) restoreReadingAnchor(elements.messages, anchor);
    const latest = await threadApi.turns(threadId, "limit=1").catch(() => null);
    if (latest && state.selectedThread?.id === threadId && state.activeTurnId === turnId) {
      const reading = captureReadingAnchor(elements.messages, [...elements.messages.querySelectorAll(".message-row, .activity-card")]);
      mergeTurnsPage(latest.data || []);
      if (!wasFollowing) restoreReadingAnchor(elements.messages, reading);
    }
    requestAnimationFrame(() => {
      if (wasFollowing && state.selectedThread?.id === threadId) scrollToBottom(true);
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
  if (previousThreadId && previousThreadId !== thread.id) {
    clearTimeout(state.draftSaveTimer);
    saveThreadDraft(previousThreadId);
    state.itemTimings.clear();
  }
  clearStreamingRenderTimers();
  const wasFollowing = shouldFollowOutput();
  const bottomOffset = Math.max(
    0,
    elements.messages.scrollHeight - elements.messages.clientHeight - elements.messages.scrollTop,
  );
  state.selectedThread = thread;
  state.transcriptSignatures.clear();
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
    } else if (!preserveScroll && !state.activeTurnId && restoreSelectedThreadView(thread.id)) {
      elements.scrollBottomButton.classList.remove("hidden");
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

function isThreadWriteConflict(error) {
  return error?.details?.code === "THREAD_WRITE_CONFLICT"
    || /active\s+writer|writer.*(?:active|busy|owned)|(?:already|currently).*(?:writing|steer|running)|cannot\s+(?:start|steer|interrupt).*turn/i.test(String(error?.message || ""));
}

function markThreadWriteConflict(threadId, error) {
  if (!threadId || !isThreadWriteConflict(error)) return false;
  state.writeConflicts.set(threadId, {
    message: error.message,
    at: Date.now(),
  });
  if (state.selectedThread?.id === threadId) updateTurnControls();
  return true;
}

function clearThreadWriteConflict(threadId) {
  if (!threadId) return;
  state.writeConflicts.delete(threadId);
  if (state.selectedThread?.id === threadId) updateTurnControls();
}

function reorderTurnGroups() {
  const order = new Map((state.selectedThread?.turns || []).map((turn, index) => [turn.id, index]));
  const groups = [...elements.messages.querySelectorAll(".turn-group")]
    .sort((left, right) => (order.get(left.dataset.turnId) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.dataset.turnId) ?? Number.MAX_SAFE_INTEGER));
  const newer = elements.messages.querySelector('.history-window-nav[data-direction="newer"]');
  const before = [...elements.messages.children].filter((node) => !groups.includes(node) && node !== newer);
  reconcileChildren(elements.messages, [...before, ...groups, ...(newer ? [newer] : [])]);
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
    } else {
      updateTurnGroup(group, turn, { replaceItems });
    }
  }
  reorderTurnGroups();
  renderKnownArtifacts();
  return added;
}

async function refreshSelectedThread({ preserveScroll = true, isCurrent = () => true } = {}) {
  const threadId = state.selectedThread?.id;
  if (!threadId || !isCurrent()) return false;
  if (state.historyContext.active && state.historyContext.threadId === threadId) {
    markHistoryContextUpdated();
    return false;
  }
  const sequence = ++state.openThreadSequence;
  const wasFollowing = shouldFollowOutput();
  const params = new URLSearchParams();
  if (!state.selectedThread.archived) params.set("subscribe", "true");
  const suffix = params.size ? `?${params}` : "";
  const result = await threadApi.get(threadId, suffix);
  if (sequence !== state.openThreadSequence || state.selectedThread?.id !== threadId || !isCurrent()) return false;
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
  return isCurrent() && !result.subscriptionError;
}

async function openThread(threadId, {
  silent = false,
  preserveScroll = false,
  updateRoute = true,
  isCurrent = () => true,
  archived = state.selectedThread?.id === threadId ? Boolean(state.selectedThread.archived) : false,
} = {}) {
  if (!threadId) return;
  if (silent && state.selectedThread?.id === threadId) {
    return refreshSelectedThread({ preserveScroll, isCurrent });
  }
  closeAllMenus();
  const switchingThreads = state.selectedThread?.id && state.selectedThread.id !== threadId;
  if (!silent && switchingThreads && state.uploadRequest) {
    showToast(uiText("app.openThread.showToast3"));
    return;
  }
  if (!silent && switchingThreads && state.pendingFiles.length) {
    showToast(uiText("app.openThread.showToast2"));
    return;
  }
  const sequence = ++state.openThreadSequence;
  const loadingToken = silent ? null : showLoadingToast(uiText("app.openThread.showLoadingToast"));
  if (!silent) elements.chatTitle.textContent = uiText("app.openThread.textContent2");
  try {
    const params = new URLSearchParams();
    if (!archived) params.set("subscribe", "true");
    const suffix = params.size ? `?${params}` : "";
    const result = await threadApi.get(threadId, suffix);
    if (sequence !== state.openThreadSequence) return;
    // A silent reconnect may have started before the user opened a history
    // node. Do not let its late response replace the selected context view.
    if (silent && state.historyContext.active && state.historyContext.threadId === threadId) {
      markHistoryContextUpdated();
      return;
    }
    clearThreadUnread(threadId);
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
    if (updateRoute) updateThreadRoute(threadId, { archived });
    if (!silent) closeSidebar();
    if (result.activeTranscriptAvailable && result.activeTurnId) {
      await restoreActiveTranscript(threadId, result.activeTurnId, { force: true, follow: !preserveScroll });
    }
    if (result.goalSupported === undefined) await loadThreadGoal(threadId);
    await loadThreadArtifacts(threadId).catch(() => {});
    if (sequence !== state.openThreadSequence || state.selectedThread?.id !== threadId) return;
    if (result.subscriptionError) showToast(uiText("app.openThread.showToast", result.subscriptionError));
  } catch (error) {
    if (sequence !== state.openThreadSequence) return;
    showToast(error.message);
    if (state.selectedThread) updateChatHeader();
    else {
      elements.chatTitle.textContent = "Codex Remote";
      elements.chatMeta.textContent = uiText("app.openThread.textContent");
      elements.chatMeta.removeAttribute("title");
      elements.chatMeta.removeAttribute("aria-label");
    }
  } finally {
    if (loadingToken) finishLoadingToast(loadingToken);
  }
}

async function loadOlderTurns() {
  if (!state.selectedThread || !state.historyCursor || state.historyLoading) return;
  const threadId = state.selectedThread.id;
  const cursor = state.historyCursor;
  state.historyLoading = true;
  const loadingToken = showLoadingToast("正在加载更多历史对话…");
  updateHistoryControls();
  try {
    const params = new URLSearchParams({ cursor, items: "full" });
    const page = await threadApi.turns(threadId, params);
    if (state.selectedThread?.id !== threadId) return;
    if (!canRetainHistoryPage(page.data || [])) {
      markHistoryMemoryLimited();
      return;
    }
    if (state.historyWindow.enabled) {
      const firstId = state.selectedThread.turns[state.historyWindow.start]?.id;
      mergeTurnsPage(page.data || [], { prepend: true, deferRender: true });
      const windowStart = Math.max(0, state.selectedThread.turns.findIndex((turn) => turn.id === firstId));
      renderHistoryWindow({ start: windowStart, scroll: "preserve" });
    } else {
      const anchor = captureReadingAnchor(elements.messages, [...elements.messages.querySelectorAll(".message-row, .activity-card")]);
      renderTurnsPage(page.data || [], { prepend: true });
      requestAnimationFrame(() => {
        if (state.selectedThread?.id === threadId) restoreReadingAnchor(elements.messages, anchor);
      });
    }
    renderKnownArtifacts();
    renderChangesPanel();
    state.historyCursor = page.nextCursor || null;
    if (state.historyCompleteStarted) state.historyCompleteCursor = state.historyCursor;
    if (state.historyCompleteStarted && !state.historyCursor) state.historyComplete = true;
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
    const page = await threadApi.turns(threadId, params);
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
      const page = await threadApi.turns(threadId, params);
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
    const firstId = elements.messages.querySelector(".turn-group")?.dataset.turnId;
    const readingStart = (state.selectedThread?.turns || []).findIndex((turn) => turn.id === firstId);
    renderHistoryWindow({
      start: wasFollowing ? Math.max(0, (state.selectedThread?.turns?.length || 0) - state.historyWindow.size) : Math.max(0, readingStart),
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
  state.itemTimings.clear();
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
  try {
    const params = new URLSearchParams({
      cursor,
      items: "full",
      limit: String(HISTORY_CONTEXT_PAGE_SIZE),
      sort: direction === "newer" ? "asc" : "desc",
    });
    const page = await threadApi.turns(threadId, params);
    if (state.selectedThread?.id !== threadId || !state.historyContext.active || state.historyContext.sequence !== sequence) return false;
    const incoming = chronologicalTurns(page.data || [], page.sortDirection || (direction === "newer" ? "asc" : "desc"));
    const merged = mergeHistoryContextTurns(incoming, direction);
    if (!historyCollectionFits(merged)) {
      markHistoryMemoryLimited();
      return false;
    }
    const firstId = state.selectedThread.turns[state.historyWindow.start]?.id;
    state.selectedThread.turns = merged;
    syncHistoryRetention(merged);
    collectTurnFileChanges(incoming, { older: direction === "older" });
    if (direction === "older") context.olderCursor = page.nextCursor || null;
    else context.newerCursor = page.nextCursor || null;
    state.historyComplete = !context.olderCursor && !context.newerCursor;
    if (render) {
      const start = Math.max(0, merged.findIndex((turn) => turn.id === firstId));
      renderHistoryWindow({ start, scroll: "preserve" });
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
    const firstId = elements.messages.querySelector(".turn-group")?.dataset.turnId;
    const firstIndex = state.selectedThread.turns.findIndex((turn) => turn.id === firstId);
    renderHistoryWindow({ start: Math.max(0, firstIndex), scroll: "preserve" });
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
    const page = await threadApi.turns(threadId, params);
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
  const cwd = state.selectedThread.cwd || "";
  const parts = [cwd ? `工作目录：${basename(cwd)}` : "工作目录未知"];
  if (state.selectedThread.gitInfo?.branch) parts.push(state.selectedThread.gitInfo.branch);
  parts.push(`创建来源：${sourceLabel(state.selectedThread)}`);
  parts.push(statusInfo(state.selectedThread.status).label);
  elements.chatMeta.textContent = parts.filter(Boolean).join(" · ");
  elements.chatMeta.title = `${cwd || "工作目录未知"} · 创建来源：${sourceLabel(state.selectedThread)}`;
  elements.chatMeta.setAttribute("aria-label", `${cwd ? `工作目录：${cwd}` : "工作目录未知"}；创建来源：${sourceLabel(state.selectedThread)}`);
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
  elements.pinThreadButton.textContent = state.pinned.has(state.selectedThread.id) ? uiText("common.unpin") : uiText("common.pin");
  elements.archiveThreadButton.textContent = state.selectedThread.archived ? uiText("common.restore") : uiText("common.archive");
  elements.goalThreadButton.textContent = state.goal ? uiText("common.editGoal") : uiText("common.createGoal");
  elements.releaseThreadButton.disabled = running || releasing || !owned;
  elements.releaseThreadButton.textContent = running
    ? uiText("app.updateChatActions.textContent3")
    : releasing
      ? uiText("app.updateChatActions.textContent2")
      : owned
        ? uiText("html.releaseThreadButton.text")
        : uiText("app.updateChatActions.textContent");
}

function renderWriteQueueStatus() {
  const requests = writeRequests.snapshot(state.selectedThread?.id);
  const ids = new Set(requests.map((request) => request.id));
  for (const row of [...elements.writeQueueStatus.children]) {
    if (!ids.has(row.dataset.requestId)) row.remove();
  }
  for (const request of requests) {
    let row = elements.writeQueueStatus.querySelector(`[data-request-id="${request.id}"]`);
    if (!row) {
      row = el("div", "write-queue-row");
      row.dataset.requestId = request.id;
      row.append(el("span", "write-queue-copy"));
      const cancel = el("button", "", "取消等待");
      cancel.type = "button";
      cancel.addEventListener("click", async () => {
        try {
          const receipt = await writeRequests.cancel(request.id);
          if (receipt?.state === "cancelled") showToast("已取消等待，操作尚未发送给 Codex");
          else if (receipt) showToast("操作已开始处理，无法取消等待；请核对任务结果");
        } catch {
          showToast("尚未确认取消成功，请等待原请求结果或刷新核对", 6000);
        }
      });
      row.append(cancel);
      elements.writeQueueStatus.append(row);
    }
    const writer = request.waitingOn;
    const waiting = writer ? `等待${writer.currentDevice ? "此设备" : writer.label}的操作完成` : "等待前面的操作完成";
    row.querySelector("span").textContent = request.cancelling ? `${request.label}：正在确认取消…`
      : request.state === "queued" ? `${request.label}：${waiting}（排队第 ${request.position} 位）`
      : request.state === "running" ? `${request.label}：正在处理，等待确认`
      : request.state === "cancelled" ? `${request.label}：已确认取消`
      : request.state === "succeeded" ? `${request.label}：已确认完成`
      : request.state === "failed" ? `${request.label}：操作未完成`
      : request.state === "checking" ? `${request.label}：正在核对请求状态…`
      : `${request.label}：正在提交…`;
    const cancel = row.querySelector("button");
    cancel.disabled = request.state !== "queued" || request.cancelling;
    cancel.setAttribute("aria-label", `取消等待：${request.label}`);
  }
  elements.writeQueueStatus.classList.toggle("hidden", requests.length === 0);
}

function updateTurnControls() {
  renderWriteQueueStatus();
  elements.sendButton.disabled = state.pendingComposerSends.has(state.selectedThread?.id);
  const running = Boolean(state.activeTurnId);
  elements.stopButton.classList.toggle("hidden", !running);
  elements.sendButton.classList.toggle("running", running);
  elements.promptInput.placeholder = running ? uiText("app.updateTurnControls.placeholder") : uiText("html.promptInput.placeholder");
  const threadId = state.selectedThread?.id;
  const releasing = threadId && state.releasingThreads.has(threadId);
  const owned = threadId && state.ownedThreads.has(threadId);
  const writeConflict = threadId && state.writeConflicts.get(threadId);
  const pending = hasPendingSettings(threadId);
  elements.composerHint.textContent = writeConflict
    ? uiText("app.updateTurnControls.textContent7")
    : running
    ? pending
      ? uiText("app.updateTurnControls.textContent6")
      : uiText("app.updateTurnControls.textContent5")
    : releasing
      ? uiText("app.updateTurnControls.textContent4")
      : owned
        ? pending
          ? uiText("app.updateTurnControls.textContent3")
          : uiText("app.updateTurnControls.textContent2")
        : uiText("app.updateTurnControls.textContent");
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

const diagnosticsView = createDiagnosticsView({ state, elements, el, basename, sourceLabel, settingsState, displayedSettings, modelFor, effortLabel, permissionLabels });
function renderInfoPanel() { return diagnosticsView.renderInfoPanel(); }

function toggleContext(force) {
  const open = force ?? !elements.contextPanel.classList.contains("open");
  if (open) closeAllMenus();
  navigationPanels.context(open);
}

function setContextTab(tab) {
  const changes = tab === "changes";
  elements.changesTab.classList.toggle("active", changes);
  elements.infoTab.classList.toggle("active", !changes);
  elements.changesTab.setAttribute("aria-selected", String(changes));
  elements.infoTab.setAttribute("aria-selected", String(!changes));
  elements.changesTab.setAttribute("tabindex", changes ? "0" : "-1");
  elements.infoTab.setAttribute("tabindex", changes ? "-1" : "0");
  elements.changesPanel.classList.toggle("hidden", !changes);
  elements.infoPanel.classList.toggle("hidden", changes);
  elements.changesPanel.setAttribute("aria-hidden", String(!changes));
  elements.infoPanel.setAttribute("aria-hidden", String(changes));
}

function approvalContext(approval) {
  const params = approval?.params || {};
  const threadId = params.threadId;
  const settings = threadId ? settingsState(threadId).effective : {};
  const thread = state.threads.find((item) => item.id === threadId);
  const cwd = params.cwd || params.workingDirectory || params.workdir || params.item?.cwd || thread?.cwd;
  const command = approvalCommand(approval);
  const files = approvalFilePaths(approval);
  const context = [];
  if (cwd) context.push([uiText("common.workDirectory"), String(cwd)]);
  if (params.grantRoot) context.push([uiText("app.approvalContext.push9"), String(params.grantRoot)]);
  if (params.additionalPermissions) context.push([uiText("app.approvalContext.push8"), confirmationPreview(JSON.stringify(params.additionalPermissions), 500)]);
  if (params.networkApprovalContext) context.push([uiText("app.approvalContext.push7"), confirmationPreview(JSON.stringify(params.networkApprovalContext), 500)]);
  if (command) context.push([uiText("app.approvalContext.push6"), confirmationPreview(command, 500)]);
  if (files.length) context.push([uiText("app.approvalContext.push5"), `${files.join("、")}${approvalFilePaths(approval).length >= 8 ? uiText("app.approvalContext.push4") : ""}`]);
  const fileNotice = approvalFileContextNotice(approval);
  if (fileNotice) context.push([uiText("app.approvalContext.push3"), fileNotice]);
  const decisionNotice = approvalDecisionNotice(approval);
  if (decisionNotice) context.push([uiText("app.approvalContext.push2"), decisionNotice]);
  if (settings.model) context.push([uiText("common.model"), modelFor(settings.model)?.displayName || settings.model]);
  if (settings.permissionPreset) context.push([uiText("app.approvalContext.push"), permissionLabels[settings.permissionPreset] || settings.permissionPreset]);
  return context;
}

function isQuestionRequest(method) {
  return method === "item/tool/requestUserInput" || method === "tool/requestUserInput";
}

const renderedApprovalCards = new Map();
function renderApprovals() {
  const entries = [...state.approvals].filter(([, approval]) => !state.selectedThread
    || !approval.params?.threadId || approval.params.threadId === state.selectedThread.id);
  const visible = new Set(entries.map(([requestId]) => requestId));
  for (const [requestId, record] of renderedApprovalCards) {
    if (visible.has(requestId)) continue;
    record.node.remove();
    renderedApprovalCards.delete(requestId);
  }
  let previous = null;
  for (const [requestId, approval] of entries) {
    const signature = JSON.stringify([approval.requestToken, approval.method, approval.params, approval.fileChangeContext, approvalContext(approval)]);
    let record = renderedApprovalCards.get(requestId);
    if (!record || record.signature !== signature) {
      const node = isQuestionRequest(approval.method)
        ? renderQuestionRequest(requestId, approval) : renderApprovalRequest(requestId, approval);
      record?.node.remove();
      record = { node, signature };
      renderedApprovalCards.set(requestId, record);
    }
    const busy = submissionState(approval);
    record.node.setAttribute("aria-busy", String(busy === "submitting"));
    for (const control of record.node.querySelectorAll("button, input")) control.disabled = Boolean(busy);
    const next = previous ? previous.nextSibling : elements.approvalArea.firstChild;
    if (record.node !== next) elements.approvalArea.insertBefore(record.node, next);
    previous = record.node;
  }
}

function renderApprovalRequest(requestId, approval) {
  const card = el("section", "approval-card");
  const heading = el("div", "approval-heading");
  const isFile = approval.method.includes("fileChange") || approval.method === "applyPatchApproval";
  const risk = approvalRisk(approval);
  heading.append(el("strong", "", isFile ? uiText("app.renderApprovalRequest.el2") : uiText("app.renderApprovalRequest.el")), el("span", `approval-risk ${risk.level}`, risk.label));
  const context = approvalContext(approval);
  const contextList = el("dl", "approval-context");
  for (const [label, value] of context) {
    const term = el("dt", "", label);
    const description = el("dd", "", value);
    description.title = value;
    contextList.append(term, description);
  }
  const detail = el("pre", "approval-detail", approvalDetail(approval));
  const actions = el("div", "approval-actions");
  for (const decision of approvalDecisionIds(approval)) {
    const [label, , className] = APPROVAL_CHOICES.find((choice) => choice[1] === decision);
    const button = el("button", className, label);
    button.type = "button";
    button.addEventListener("click", () => answerApproval(requestId, decision));
    actions.append(button);
  }
  card.append(heading, ...(context.length ? [contextList] : []), detail, actions);
  return card;
}

function renderQuestionRequest(requestId, approval) {
  const card = el("form", "question-card");
  const heading = el("div", "approval-heading");
  heading.append(el("strong", "", uiText("app.renderQuestionRequest.el3")), el("span", "", uiText("app.renderQuestionRequest.el2")));
  card.append(heading);
  for (const question of approval.params?.questions || []) {
    const field = el("div", "question-field");
    field.dataset.questionId = question.id;
    const title = el("span", "", question.question || question.header || uiText("app.renderQuestionRequest.el"));
    title.id = `question-title-${encodeURIComponent(String(requestId))}-${encodeURIComponent(String(question.id))}`;
    field.setAttribute("role", "group");
    field.setAttribute("aria-labelledby", title.id);
    field.append(title);
    if (question.options?.length) {
      const options = el("div", "question-options");
      options.setAttribute("role", "radiogroup");
      options.setAttribute("aria-labelledby", title.id);
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
      input.placeholder = question.isOther && question.options?.length ? uiText("app.renderQuestionRequest.placeholder2") : uiText("app.renderQuestionRequest.placeholder");
      input.setAttribute("aria-label", `${title.textContent}${question.isOther && question.options?.length ? uiText("app.renderQuestionRequest.setAttribute") : ""}`);
      input.dataset.freeform = "true";
      field.append(input);
    }
    card.append(field);
  }
  const actions = el("div", "approval-actions");
  const submit = el("button", "approve", uiText("headings.submit_answers"));
  submit.type = "submit";
  actions.append(submit);
  card.append(actions);
  card.addEventListener("submit", (event) => answerQuestion(event, requestId));
  return card;
}

async function loadStatus({ isCurrent = () => true } = {}) {
  const sequence = ++state.statusLoadSequence;
  const approvalRevision = state.approvalRevision;
  const status = await api("/api/status");
  if (sequence !== state.statusLoadSequence || !state.auth.authenticated || !isCurrent()) return false;
  state.roots = status.roots || [];
  state.accessRoots = status.accessRoots || {
    configured: state.roots.map((path) => ({ path, name: basename(path), removable: false })),
    additional: [],
    roots: state.roots.map((path) => ({ path, name: basename(path) })),
    maxAdditionalRoots: 32,
  };
  state.rootAccessPolicy = status.rootAccessPolicy || null;
  state.appRoot = status.appRoot || "";
  state.version = status.version || "";
  state.protocol = status.protocol || null;
  state.eventReplay = status.eventReplay || null;
  state.taskRecovery = status.taskRecovery || null;
  state.ownedThreads = new Set(status.ownedThreads || []);
  state.releasingThreads = new Set(status.releasingThreads || []);
  elements.cwdInput.value ||= state.roots[0] || "";
  elements.instanceName.textContent = status.instanceName || "Linux Server";
  elements.networkLabel.textContent = status.networkLabel || "受控私有网络";
  setConnection(status.bridge, status.error);
  const pendingApprovals = new Map();
  for (const approval of status.pendingApprovals || []) {
    const requestId = approvalRequestId(approval?.requestId);
    if (requestId === null) continue;
    const previous = state.approvals.get(requestId);
    pendingApprovals.set(requestId, sameApprovalRequest(previous, approval) ? previous : approval);
  }
  if (approvalRevision === state.approvalRevision) state.approvals = pendingApprovals;
  // The global map only covers writers known to this bridge and can lag a
  // Windows-owned task. The selected thread's authoritative writer state is
  // reconciled by openThread()/refreshSelectedThread(), not by this snapshot.
  updateTurnControls();
  updateChatActions();
  renderApprovals();
  return status.bridge === "ready";
}


function pathWithinDirectory(path, directory) {
  const normalizedPath = String(path || "").replace(/\/+$/, "") || "/";
  const normalizedDirectory = String(directory || "").replace(/\/+$/, "") || "/";
  return normalizedPath === normalizedDirectory
    || normalizedDirectory === "/"
    || normalizedPath.startsWith(`${normalizedDirectory}/`);
}

function supportTaskCwd() {
  const candidates = [state.appRoot, state.selectedThread?.cwd, stored.lastDirectory, state.roots[0]];
  return candidates.find((candidate) => candidate && state.roots.some((root) => pathWithinDirectory(candidate, root))) || state.roots[0] || "";
}

function supportTaskPrompt(question, mode = "help") {
  const appVersion = state.version || uiText("app.supportTaskPrompt.text");
  const maintenance = mode === "maintenance";
  return [
    uiText("app.supportTaskPrompt.join7"),
    uiText("app.supportTaskPrompt.join6", appVersion),
    uiText("app.supportTaskPrompt.join5"),
    maintenance
      ? uiText("app.supportTaskPrompt.join4")
      : uiText("app.supportTaskPrompt.join3"),
    uiText("app.supportTaskPrompt.join2"),
    uiText("app.supportTaskPrompt.join", String(question || uiText("app.supportTaskPrompt.String")).trim()),
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
    showToast(uiText("app.startSupportTask.showToast"), 3600);
    elements.helpQuestionInput.focus();
    return;
  }
  elements.helpDialog.close();
  openNewTaskDialog(supportTaskPrompt(question, mode));
  elements.cwdInput.value = supportTaskCwd();
  elements.newPermissionSelect.value = "request";
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

const taskComposer = createTaskComposer({
  state,
  elements,
  stored,
  api,
  writeRequests,
  storage: localStorage,
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
});
function openNewTaskDialog(...args) { return taskComposer.openNewTaskDialog(...args); }
function createTask(...args) { return taskComposer.createTask(...args); }
function sendPrompt(...args) { return taskComposer.sendPrompt(...args); }
function stopTurn(...args) { return taskComposer.stopTurn(...args); }

const notificationHandler = createNotificationHandler({
  state,
  elements,
  storage: localStorage,
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
  maxLiveCommandChars: MAX_LIVE_COMMAND_CHARS
});
function handleNotification(message) { return notificationHandler.handleNotification(message); }
function updateThreadStatus(...args) { return notificationHandler.updateThreadStatus(...args); }

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
    ? state.activeTurnId ? uiText("app.saveSettings.showToast3") : uiText("app.saveSettings.showToast2")
    : uiText("app.saveSettings.showToast"));
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
  if (menu.element?.contains(document.activeElement) && canFocus(menu.anchor)) focusWithoutScroll(menu.anchor);
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
    elements.loginButton.textContent = uiText("app.wireEvents.textContent2");
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
      elements.loginButton.textContent = uiText("app.wireEvents.textContent");
    }
  });
  elements.changeCredentialsLoginButton.addEventListener("click", openCredentialsDialog);
  elements.logoutButton.addEventListener("click", async () => {
    const confirmed = await requestConfirmation({
      eyebrow: uiText("common.logout"),
      title: uiText("devices.renderDevices.title2"),
      message: uiText("app.wireEvents.message2"),
      confirmLabel: uiText("common.logoutCurrent"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
    } catch (error) {
      if (!/登录/.test(error.message)) showToast(error.message);
    }
    showLogin(uiText("app.wireEvents.showLogin2"));
  });
  elements.logoutAllButton.addEventListener("click", async () => {
    const confirmed = await requestConfirmation({
      eyebrow: uiText("common.logoutAll"),
      title: uiText("app.wireEvents.title"),
      message: uiText("app.wireEvents.message"),
      confirmLabel: uiText("app.wireEvents.confirmLabel"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api("/api/auth/logout-all", { method: "POST", body: "{}" });
      showLogin(uiText("app.wireEvents.showLogin"));
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
      showToast(uiText("app.wireEvents.showToast2"));
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
  elements.manageAccessRootsButton.addEventListener("click", openAccessRoots);
  elements.closeAccessRootsButton.addEventListener("click", () => elements.accessRootsDialog.close());
  elements.accessRootForm.addEventListener("submit", addAccessRoot);
  elements.accessRootsDialog.addEventListener("click", (event) => {
    if (event.target === elements.accessRootsDialog) elements.accessRootsDialog.close();
  });
  elements.refreshFileBrowserButton.addEventListener("click", () => {
    if (state.fileBrowser.path) loadFileBrowser(state.fileBrowser.path, { preserveSearch: true }).catch((error) => showToast(error.message));
  });
  elements.fileBrowserSearch.addEventListener("input", debounce(() => {
    if (state.fileBrowser.path) loadFileBrowser(state.fileBrowser.path, { preserveSearch: true }).catch((error) => showToast(error.message));
  }, 300));
  elements.fileBrowserSearchAll.addEventListener("change", () => {
    state.fileBrowser.searchAllRoots = elements.fileBrowserSearchAll.checked;
    localStorage.setItem("codex-pwa-file-search-all", state.fileBrowser.searchAllRoots ? "1" : "0");
    if (state.fileBrowser.path) loadFileBrowser(state.fileBrowser.path, { preserveSearch: true }).catch((error) => showToast(error.message));
  });
  elements.showHiddenFiles.addEventListener("change", () => {
    if (state.fileBrowser.path) loadFileBrowser(state.fileBrowser.path, { preserveSearch: true }).catch((error) => showToast(error.message));
  });
  elements.uploadToDirectoryButton.addEventListener("click", () => {
    if (state.uploadRequest && state.uploadContext === "browser") {
      state.uploadPaused = false;
      state.uploadRequest.abort();
    } else if (state.uploadPaused && state.browserUploadSession) {
      clearBrowserUploadSession();
    } else elements.fileBrowserUploadInput.click();
  });
  elements.pauseFileBrowserUploadButton.addEventListener("click", pauseBrowserDirectoryUpload);
  elements.fileBrowserUploadInput.addEventListener("change", () => {
    uploadFilesToBrowserDirectory(elements.fileBrowserUploadInput.files || []);
    elements.fileBrowserUploadInput.value = "";
  });
  elements.newFileBrowserFolderButton.addEventListener("click", createFileBrowserFolder);
  elements.copySelectedFilesButton.addEventListener("click", () => operateSelectedFileBrowserEntries("copy"));
  elements.moveSelectedFilesButton.addEventListener("click", () => operateSelectedFileBrowserEntries("move"));
  elements.deleteSelectedFilesButton.addEventListener("click", deleteSelectedFileBrowserEntries);
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
  notificationController = createBrowserNotificationController({
    environment: window,
    storage: localStorage,
    getSelectedThreadId: () => state.selectedThread?.id,
    isPushEnabled: () => pushNotificationController?.enabled() === true,
    onToast: showToast,
    onOpen: (threadId) => {
      if (!state.auth.authenticated) {
        updateThreadRoute(threadId, { archived: false });
        return;
      }
      openThread(threadId, { updateRoute: true }).catch(() => {});
    },
  });
  pushNotificationController = createPushNotificationController({ environment: window, api, elements,
    pageNotifications: notificationController, onToast: showToast });
  elements.notificationButton.addEventListener("click", enableBrowserNotifications);
  syncNotificationControl();
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
  wireTabKeyboard(
    [elements.recentTab, elements.allHistoryTab, elements.archivedTab],
    (tab) => tab === elements.recentTab
      ? setListMode("recent")
      : tab === elements.allHistoryTab
        ? setListMode("all")
        : setListMode("archived"),
  );
  elements.threadFilter.addEventListener("change", () => setThreadFilter(elements.threadFilter.value));
  elements.threadProjectFilter.addEventListener("change", () => setThreadProjectFilter(elements.threadProjectFilter.value));
  elements.threadTagFilter.addEventListener("change", () => setThreadTagFilter(elements.threadTagFilter.value));
  elements.selectVisibleThreadsButton.addEventListener("click", () => {
    const candidates = visibleThreadCandidates();
    const allSelected = candidates.length > 0 && candidates.every((thread) => state.selectedThreadIds.has(thread.id));
    for (const thread of candidates) {
      if (allSelected) state.selectedThreadIds.delete(thread.id);
      else state.selectedThreadIds.add(thread.id);
    }
    renderThreads();
  });
  elements.markSelectedThreadsReadButton.addEventListener("click", () => markSelectedThreadsRead());
  elements.archiveSelectedThreadsButton.addEventListener("click", () => archiveSelectedThreads());
  elements.clearSelectedThreadsButton.addEventListener("click", () => {
    state.selectedThreadIds.clear();
    renderThreads();
  });
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
    scheduleSelectedThreadViewSave();
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
  wireTabKeyboard(
    [elements.changesTab, elements.infoTab],
    (tab) => setContextTab(tab === elements.changesTab ? "changes" : "info"),
  );
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
    // Native close events are queued; an earlier opening may have closed while
    // a new confirmation is already visible and owns a different resolver.
    if (!elements.confirmDialog.open && state.confirmResolver) finishConfirmation(false);
  });
  elements.closeRenameButton.addEventListener("click", () => elements.renameDialog.close());
  elements.renameForm.addEventListener("submit", renameThread);
  elements.closeTagButton.addEventListener("click", () => elements.tagDialog.close());
  elements.tagForm.addEventListener("submit", saveThreadTags);
  elements.modelChip.addEventListener("click", openSettingsDialog);
  elements.effortChip.addEventListener("click", openSettingsDialog);
  elements.closeSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
  elements.settingsForm.addEventListener("submit", saveSettings);
  elements.settingsModelSelect.addEventListener("change", () => syncEffortOptions(elements.settingsEffortSelect, elements.settingsModelSelect.value, ""));
  elements.closeGoalButton.addEventListener("click", () => elements.goalDialog.close());
  elements.goalForm.addEventListener("submit", saveGoal);
  for (const dialog of [elements.newTaskDialog, elements.renameDialog, elements.tagDialog, elements.settingsDialog, elements.goalDialog, elements.deviceRenameDialog, elements.credentialsDialog, elements.accessRootsDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      if (dialog === elements.newTaskDialog && state.uploadRequest && state.uploadContext === "new") {
        showToast(uiText("app.wireEvents.showToast"));
        return;
      }
      dialog.close();
    });
  }
  document.addEventListener("pointerdown", closeOpenMenus, true);
  document.addEventListener("scroll", (event) => {
    const menu = state.floatingMenu;
    // A background conversation update may scroll while a file dialog is
    // open. Only scrolling an ancestor of the trigger invalidates its menu.
    if (menu && event.target !== document && !event.target.contains?.(menu.anchor)) return;
    if (menu) {
      // Layout changes can queue a scroll event before the menu opens. Ignore
      // that late event when the trigger has not moved since opening.
      const anchor = menu.anchor.getBoundingClientRect();
      if (anchor.top === menu.anchorRect.top && anchor.left === menu.anchorRect.left) return;
    }
    closeAllMenus();
  }, true);
  document.addEventListener("touchmove", closeAllMenus, { passive: true, capture: true });
  window.addEventListener("blur", closeAllMenus);
  window.addEventListener("resize", closeAllMenus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") closeAllMenus();
    else if (!state.historyContext.active) clearThreadUnread(state.selectedThread?.id);
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
    void eventConnection.recover();
  });
  window.addEventListener("popstate", () => {
    const threadId = routeThreadId();
    if (threadId) openThread(threadId, { updateRoute: false, archived: routeThreadArchived() }).catch((error) => showToast(error.message));
    else clearSelectedThread({ updateRoute: false });
  });
  window.addEventListener("beforeunload", () => {
    saveThreadDraft(state.selectedThread?.id);
    rememberSelectedThreadView();
  });
  setInterval(refreshVisibleState, 15_000);
  setInterval(refreshRelativeTimes, 30_000);
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || document.querySelector("dialog[open]")) return;
    if (document.activeElement?.closest?.('[role="menu"]')) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
    if (!typing && event.key.toLowerCase() === "n") openNewTaskDialog();
    if (event.key === "Escape") { closeAllMenus(); closeSidebar(); toggleContext(false); }
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (!["OPEN_NOTIFICATION_THREAD", "PUSH_TASK_UPDATED"].includes(event.data?.type)) return;
    const threadId = event.data.threadId;
    const source = event.source?.scriptURL;
    if (source !== new URL("/sw.js", window.location.origin).href
      || typeof threadId !== "string" || !threadId || threadId.length > 160) return;
    if (event.data.type === "PUSH_TASK_UPDATED") {
      markThreadUnread(threadId);
      if (state.selectedThread?.id === threadId) void eventConnection.recover();
      return;
    }
    if (!state.auth.authenticated) updateThreadRoute(threadId, { archived: false });
    else openThread(threadId, { updateRoute: true }).catch(() => {});
  });
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
    void pushNotificationController?.refresh();
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
