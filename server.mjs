import { uiText } from "./public/ui-copy.js";
import { createServer } from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCanonicalPathWithinRoots, isPathWithinRoots } from "./file-access.mjs";
import { LoginRateLimiter, TrustedDeviceStore } from "./auth-store.mjs";
import { EventReplayBuffer } from "./event-replay.mjs";
import { createSseEvents } from "./sse-events.mjs";
import { normalizeErrorStatus, publicErrorMessage } from "./error-utils.mjs";
import { createStaticServer } from "./static-server.mjs";
import { createAuthApi } from "./auth-api.mjs";
import { createFileApi } from "./file-api.mjs";
import { createCodexAppServer } from "./app-server-bridge.mjs";
import { RootAccessManager } from "./root-access.mjs";
import { PushService } from "./push-service.mjs";
import { TaskRecovery } from "./task-recovery.mjs";
import { createThreadRuntime } from "./thread-runtime.mjs";
import { createThreadService } from "./thread-service.mjs";
import { createThreadArtifacts } from "./thread-artifacts.mjs";
import { createTaskApi } from "./task-api.mjs";
import { createDiagnosticsApi } from "./diagnostics-api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");
const APP_VERSION = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;
const vendorMounts = [
  { prefix: "/vendor/marked/", directory: join(here, "node_modules", "marked", "lib") },
  { prefix: "/vendor/dompurify/", directory: join(here, "node_modules", "dompurify", "dist") },
  { prefix: "/vendor/katex/", directory: join(here, "node_modules", "katex", "dist") },
  { prefix: "/vendor/pdfjs/", directory: join(here, "node_modules", "pdfjs-dist") },
];
const homeDir = process.env.HOME || process.cwd();
const host = process.env.CODEX_PWA_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.CODEX_PWA_PORT || "4177", 10);
const codexBin = process.env.CODEX_BIN || "codex";
const appServerMode = process.env.CODEX_PWA_APP_SERVER_MODE || "isolated";
const codexHome = process.env.CODEX_HOME || join(homeDir, ".codex");
const daemonSocket = process.env.CODEX_PWA_DAEMON_SOCKET ||
  join(codexHome, "app-server-control", "app-server-control.sock");
const passwordFile = process.env.CODEX_PWA_PASSWORD_FILE || "";
const usernameFile = process.env.CODEX_PWA_USERNAME_FILE ||
  (passwordFile ? join(dirname(passwordFile), "access-username") : "");
const sessionFile = process.env.CODEX_PWA_SESSION_FILE ||
  join(homeDir, ".config", "codex-pwa", "trusted-devices.json");
const instanceName = String(process.env.CODEX_PWA_INSTANCE_NAME || uiText("serverErrors.labels.String", process.env.USER || "user"))
  .trim().slice(0, 120) || "Codex Remote";
const networkLabel = String(process.env.CODEX_PWA_NETWORK_LABEL || uiText("html.networkLabel.text"))
  .trim().slice(0, 160) || uiText("html.networkLabel.text");
const configuredRootPaths = (process.env.CODEX_PWA_ROOTS || homeDir)
  .split(":")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => resolve(entry));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("CODEX_PWA_PORT must be a valid TCP port");
}
if (configuredRootPaths.length === 0 || configuredRootPaths.some((entry) => !isAbsolute(entry))) {
  throw new Error("CODEX_PWA_ROOTS must contain at least one absolute path");
}
if (!new Set(["isolated", "shared-daemon"]).has(appServerMode)) {
  throw new Error("CODEX_PWA_APP_SERVER_MODE must be isolated or shared-daemon");
}
if (appServerMode === "shared-daemon" && !isAbsolute(daemonSocket)) {
  throw new Error("CODEX_PWA_DAEMON_SOCKET must be an absolute path");
}
if (host !== "127.0.0.1" && host !== "::1" && process.env.CODEX_PWA_ALLOW_REMOTE !== "1") {
  throw new Error("Refusing a non-loopback listener without CODEX_PWA_ALLOW_REMOTE=1");
}

const configuredRoots = configuredRootPaths.map((entry) => {
  try {
    return realpathSync(entry);
  } catch {
    throw new Error(`Configured root does not exist: ${entry}`);
  }
});
const roots = [...configuredRoots];
const rootAccess = new RootAccessManager({
  configuredRoots,
  roots,
  home: realpathSync(homeDir),
  persistedPath: process.env.CODEX_PWA_ROOTS_FILE || join(homeDir, ".config", "codex-pwa", "authorized-roots.json"),
});
if (rootAccess.policy().broad) {
  console.warn("[security] CODEX_PWA_ROOTS covers the entire user home; prefer an explicit project directory for production");
}

const eventReplayPersistencePath = process.env.NODE_ENV === "production"
  ? process.env.CODEX_PWA_EVENT_REPLAY_FILE || join(codexHome, "pwa-event-replay.jsonl")
  : "";
const sseReplay = new EventReplayBuffer({
  maxEvents: 512,
  maxBytes: 8 * 1024 * 1024,
  persistencePath: eventReplayPersistencePath,
});
const MAX_SSE_QUEUE_BYTES = 4 * 1024 * 1024;
const sseEvents = createSseEvents({ replay: sseReplay, maxQueueBytes: MAX_SSE_QUEUE_BYTES });
const {
  clients: sseClients,
  closeClient: closeSseClient,
  broadcast: broadcastSse,
  closeDeviceStreams,
  closeOtherDeviceStreams,
} = sseEvents;
const MAX_CODEX_WS_PAYLOAD_BYTES = 256 * 1024 * 1024;
const SHARED_DAEMON_HEARTBEAT_MS = 20_000;
const SHARED_DAEMON_RECONNECT_MAX_DELAY_MS = 30_000;
const SENSITIVE_ENTRY_NAMES = new Set([
  ".aws",
  ".codex",
  ".config",
  ".gnupg",
  ".ssh",
  "access-password",
  "access-username",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
  "trusted-devices.json",
]);

function isSensitiveEntryName(name) {
  const normalized = String(name || "").trim().toLocaleLowerCase("en-US");
  return SENSITIVE_ENTRY_NAMES.has(normalized)
    || normalized === ".env"
    || normalized.startsWith(".env.")
    || /\.(?:cer|crt|key|p12|pfx|pem)$/i.test(normalized);
}
const RPC_OVERLOAD_RETRY_LIMIT = 4;
const RPC_READ_TIMEOUT_MS = 30_000;
const RPC_MUTATION_TIMEOUT_MS = 60_000;
const RETRYABLE_RPC_METHODS = new Set([
  "thread/read",
  "thread/list",
  "thread/turns/list",
  "thread/items/list",
  "thread/resume",
  "thread/goal/get",
  "model/list",
]);
const RPC_MUTATION_METHODS = new Set([
  "thread/archive",
  "thread/goal/clear",
  "thread/goal/set",
  "thread/metadata/update",
  "thread/name/set",
  "thread/resume",
  "thread/start",
  "thread/unarchive",
  "thread/unsubscribe",
  "turn/interrupt",
  "turn/start",
  "turn/steer",
]);
const MAX_UPLOAD_FILES = 20;
const MAX_UPLOAD_FILE_SIZE = 256 * 1024 * 1024;
const MAX_UPLOAD_BATCH_SIZE = 512 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;
const usesSharedDaemon = appServerMode === "shared-daemon";
const runtime = createThreadRuntime({
  getCodex: () => codex, usesSharedDaemon, broadcast,
  invalidateRecovery: (threadId) => taskRecovery.invalidate(threadId),
});
const { activeTurns, resetThreadOwnership, markThreadOwned, scheduleThreadRelease, forgetThreadOwnership } = runtime;
// These callbacks are invoked only after the graph is initialized and the listener starts.
const allowedThread = (...args) => threadService.allowedThread(...args);
const artifacts = createThreadArtifacts({ codexHome, allowedThread });
const { sanitizeNotificationForBrowser } = artifacts;

const authStore = new TrustedDeviceStore({ passwordFile, usernameFile, sessionFile });
const pushService = new PushService({
  authStore,
  configFile: process.env.CODEX_PWA_PUSH_CONFIG_FILE || "",
  storeFile: process.env.CODEX_PWA_PUSH_STORE_FILE || join(dirname(sessionFile), "push-subscriptions.json"),
  readThread: (threadId) => allowedThread(threadId, false),
  isRequestPending: (requestId, threadId, requestToken) => {
    const pending = codex.serverRequests.get(requestId);
    return pending?.params?.threadId === threadId && (!requestToken || pending.requestToken === requestToken);
  },
});
const taskRecovery = new TaskRecovery({
  persistencePath: process.env.CODEX_PWA_TASK_RECOVERY_FILE || (process.env.NODE_ENV === "production"
    ? join(dirname(sessionFile), "task-recovery.json") : ""),
  readSnapshot: async (threadId) => {
    const before = await allowedThread(threadId, false);
    const page = await codex.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    // Read status and authorization again after the history query. Inconsistent
    // snapshots stay unconfirmed; recovery never subscribes or claims a writer.
    const after = await allowedThread(threadId, false);
    return { threadStatus: before.status?.type === after.status?.type ? after.status : null,
      turn: page?.data?.[0] || null };
  },
  onUnconfirmed: ({ threadId, turnId }) => {
    if (activeTurns.get(threadId) === turnId) activeTurns.delete(threadId);
  },
  onRecovered: (record) => {
    if (record.status === "running") activeTurns.set(record.threadId, record.turnId);
    else if (activeTurns.get(record.threadId) === record.turnId) activeTurns.delete(record.threadId);
    broadcast({ kind: "bridge/taskRecovered", ...record });
  },
});
function broadcast(payload) {
  taskRecovery.observe(payload);
  if (payload.kind === "bridge/status") {
    if (payload.status === "ready") queueMicrotask(() => { void taskRecovery.reconcile({ force: true }); });
    else taskRecovery.invalidate();
  }
  broadcastSse(payload);
  void pushService.enqueue(payload);
}
const loginRateLimiter = new LoginRateLimiter();
const globalLoginRateLimiter = new LoginRateLimiter({ maxFailures: 100, maxKeys: 1 });

const codex = createCodexAppServer({
  codexBin,
  roots,
  usesSharedDaemon,
  daemonSocket,
  appVersion: APP_VERSION,
  maxWebSocketPayloadBytes: MAX_CODEX_WS_PAYLOAD_BYTES,
  sharedDaemonHeartbeatMs: SHARED_DAEMON_HEARTBEAT_MS,
  sharedDaemonReconnectMaxDelayMs: SHARED_DAEMON_RECONNECT_MAX_DELAY_MS,
  rpcMutationMethods: RPC_MUTATION_METHODS,
  rpcReadTimeoutMs: RPC_READ_TIMEOUT_MS,
  rpcMutationTimeoutMs: RPC_MUTATION_TIMEOUT_MS,
  retryableRpcMethods: RETRYABLE_RPC_METHODS,
  rpcOverloadRetryLimit: RPC_OVERLOAD_RETRY_LIMIT,
  autoReleaseDelayMs: 1_000,
  broadcast,
  resetThreadOwnership,
  activeTurns,
  markThreadOwned,
  scheduleThreadRelease,
  forgetThreadOwnership,
  sanitizeNotificationForBrowser,
});
const threadService = createThreadService({ codex, codexHome, usesSharedDaemon, runtime, taskRecovery, isAllowedThreadPath });
const { handleTaskApi } = createTaskApi({ codex, roots, usesSharedDaemon, service: threadService, runtime, artifacts,
  isAllowedThreadPath, resolveAllowedDirectory, broadcast, readBody, sendJson });
const { handleDiagnosticsApi } = createDiagnosticsApi({ codex, appServerMode, daemonSocket, usesSharedDaemon,
  roots, rootAccess, appRoot: here, instanceName, networkLabel, appVersion: APP_VERSION,
  sseReplay, taskRecovery, runtime, sendJson });

const taskRecoveryTimer = setInterval(() => {
  if (codex.status === "ready") void taskRecovery.reconcile();
}, 1_000);
taskRecoveryTimer.unref();

const { handleAuthApi, authenticateRequest, requireCsrf, sendUnauthorized } = createAuthApi({
  authStore,
  loginRateLimiter,
  globalLoginRateLimiter,
  codex,
  appVersion: APP_VERSION,
  sseClients,
  closeSseClient,
  closeDeviceStreams,
  closeOtherDeviceStreams,
  onSessionsChanged: () => pushService.reconcile().catch(() => {
    console.warn("[push] Subscription cleanup failed; delivery still requires an active trusted device");
  }),
  readBody,
  sendJson,
});

const { handleFileApi } = createFileApi({
  roots,
  maxUploadFiles: MAX_UPLOAD_FILES,
  maxUploadFileSize: MAX_UPLOAD_FILE_SIZE,
  maxUploadBatchSize: MAX_UPLOAD_BATCH_SIZE,
  maxDirectoryEntries: MAX_DIRECTORY_ENTRIES,
  isAllowedPath,
  resolveAllowedDirectory,
  allowedThread,
  readBody,
  sendJson,
  sensitiveEntryName: isSensitiveEntryName,
});

function isAllowedPath(candidate) {
  return isPathWithinRoots(candidate, roots);
}

function uploadError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function isAllowedThreadPath(candidate) {
  return isCanonicalPathWithinRoots(candidate, roots, { allowMissing: true });
}

async function resolveAllowedDirectory(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 8_192 || !isAbsolute(candidate)) {
    throw uploadError(uiText("serverErrors.resolveAllowedDirectory.uploadError5"));
  }
  if (!isAllowedPath(candidate)) throw uploadError(uiText("serverErrors.resolveAllowedDirectory.uploadError4"), 403);
  let actual;
  try {
    actual = await realpath(candidate);
  } catch (error) {
    if (error.code === "ENOENT") throw uploadError(uiText("serverErrors.resolveAllowedDirectory.uploadError3"), 404);
    if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
    throw error;
  }
  if (!isAllowedPath(actual)) throw uploadError(uiText("serverErrors.resolveAllowedDirectory.uploadError2"), 403);
  const details = await stat(actual);
  if (!details.isDirectory()) throw uploadError(uiText("serverErrors.resolveAllowedDirectory.uploadError"));
  return actual;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error(uiText("serverErrors.readBody.text"));
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, value, headers = {}) {
  if (response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}

function sendError(response, error, statusCode = 400) {
  console.error(error);
  const normalizedStatus = normalizeErrorStatus(error, statusCode);
  sendJson(response, normalizedStatus, {
    error: publicErrorMessage(error),
    details: error.details || null,
  });
}

async function handleApi(request, response, url, authentication, mutationSignal) {
  if (url.pathname === "/api/push/status" && request.method === "GET") {
    sendJson(response, 200, await pushService.status(authentication.session?.id));
    return;
  }
  if (url.pathname === "/api/push/subscription" && ["POST", "DELETE"].includes(request.method)) {
    if (authentication.kind !== "session") throw Object.assign(new Error(uiText("serverErrors.handleApi.assign")), { statusCode: 403 });
    const result = request.method === "POST"
      ? await pushService.subscribe(authentication.session.id, (await readBody(request)).subscription)
      : await pushService.unsubscribe(authentication.session.id);
    sendJson(response, 200, result);
    return;
  }
  if (await handleFileApi(request, response, url)) return;

  if (url.pathname === "/api/access-roots" && request.method === "GET") {
    sendJson(response, 200, rootAccess.snapshot());
    return;
  }
  if (url.pathname === "/api/access-roots" && ["POST", "DELETE"].includes(request.method)) {
    if (request.headers["x-codex-pwa-root-change"] !== "1") {
      const error = new Error(uiText("serverErrors.handleApi.text"));
      error.statusCode = 403;
      throw error;
    }
    const body = await readBody(request);
    const result = request.method === "POST"
      ? rootAccess.add(body.path)
      : rootAccess.remove(body.path);
    taskRecovery.invalidate();
    void taskRecovery.reconcile({ force: true });
    broadcast({ kind: "bridge/accessRootsChanged", roots: rootAccess.snapshot().roots });
    sendJson(response, result.added || result.removed ? 200 : 200, result);
    return;
  }

  if (await handleDiagnosticsApi(request, response, url)) return;
  if (request.method === "GET" && url.pathname === "/api/events") {
    sseEvents.openStream(request, response, url, { deviceId: authentication?.session?.id || null, status: codex.status });
    return;
  }
  if (await handleTaskApi(request, response, url, authentication, mutationSignal)) return;
  sendJson(response, 404, { error: "API endpoint not found" });
}

const { serveStatic } = createStaticServer({ publicDir, vendorMounts, sendJson });

const server = createServer(async (request, response) => {
  const mutationAbort = new AbortController();
  // IncomingMessage "close" also fires after an ordinary body read. The
  // unfinished response closing is the reliable client-disconnect boundary.
  const cancelWaitingMutation = () => {
    if (!response.writableFinished) mutationAbort.abort();
  };
  response.once("close", cancelWaitingMutation);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; manifest-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'",
  );

  try {
    // Parse only the request target. The Host header is untrusted and may be
    // syntactically invalid even when Node accepted the HTTP request itself.
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      if (await handleAuthApi(request, response, url)) return;
      const authentication = await authenticateRequest(request);
      if (!authentication) {
        sendUnauthorized(response);
        return;
      }
      requireCsrf(request, authentication);
      await handleApi(request, response, url, authentication, mutationAbort.signal);
    } else {
      await serveStatic(request, response, url);
    }
  } catch (error) {
    if (!response.destroyed) sendError(response, error, error.statusCode || 400);
  } finally {
    response.removeListener("close", cancelWaitingMutation);
  }
});

server.listen(port, host, async () => {
  console.log(`Codex PWA listening on http://${host}:${port}`);
  console.log(`Allowed roots: ${roots.join(", ")}`);
  try {
    await codex.ensureReady();
    console.log("Codex app-server bridge is ready");
  } catch (error) {
    console.error(`Codex app-server failed to start: ${error.message}`);
  }
});

function shutdown() {
  clearInterval(taskRecoveryTimer);
  taskRecovery.close();
  pushService.close();
  runtime.resetThreadOwnership();
  codex.stop();
  for (const response of [...sseClients.keys()]) closeSseClient(response);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
