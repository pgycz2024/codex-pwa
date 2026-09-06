import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { chmod, cp, link, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import Busboy from "busboy";
import WebSocket from "ws";
import {
  contentDisposition,
  filePresentation,
  isCanonicalPathWithinRoots,
  isPathWithinRoots,
  parseByteRange,
} from "./file-access.mjs";
import { numberedUploadFilename, safeUploadFilename } from "./upload-utils.mjs";
import { directoryBreadcrumbs, validateDirectoryName } from "./directory-utils.mjs";
import {
  DEVICE_COOKIE,
  LoginRateLimiter,
  TrustedDeviceStore,
  deviceCookie,
  isUnsafeMethod,
  parseCookies,
} from "./auth-store.mjs";
import {
  mergeThreadSettings,
  parseSettingsOverrides,
  serializeThreadSettings,
  threadStartPermission,
} from "./thread-settings.mjs";
import { inferClientOrigin, narrativeHistoryPage } from "./thread-history.mjs";
import {
  MAX_ARTIFACT_BYTES,
  normalizeImageArtifact,
  readRolloutArtifact,
  scanRolloutArtifacts,
} from "./artifact-store.mjs";

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
const sessionFile = process.env.CODEX_PWA_SESSION_FILE ||
  join(homeDir, ".config", "codex-pwa", "trusted-devices.json");
const instanceName = String(process.env.CODEX_PWA_INSTANCE_NAME || `${process.env.USER || "user"} 的 Codex`)
  .trim().slice(0, 120) || "Codex Remote";
const networkLabel = String(process.env.CODEX_PWA_NETWORK_LABEL || "受控私有网络")
  .trim().slice(0, 160) || "受控私有网络";
const configuredRoots = (process.env.CODEX_PWA_ROOTS || homeDir)
  .split(":")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => resolve(entry));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("CODEX_PWA_PORT must be a valid TCP port");
}
if (configuredRoots.length === 0 || configuredRoots.some((entry) => !isAbsolute(entry))) {
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

const roots = configuredRoots.map((entry) => {
  try {
    return realpathSync(entry);
  } catch {
    throw new Error(`Configured root does not exist: ${entry}`);
  }
});

const sseClients = new Map();
const activeTurns = new Map();
const ownedThreads = new Set();
const releasingThreads = new Set();
const releaseTimers = new Map();
let recycleRetryTimer = null;
const HISTORY_PAGE_SIZE = 6;
const MAX_HISTORY_PAGE_SIZE = 20;
const THREAD_LIST_PAGE_SIZE = 50;
const MAX_THREAD_LIST_PAGE_SIZE = 100;
const AUTO_RELEASE_DELAY_MS = 1_000;
const IDLE_SUBSCRIPTION_LEASE_MS = 90_000;
const HISTORY_ACTIVITY_LIMIT_PER_TURN = 40;
const HISTORY_COMMAND_PREVIEW_CHARS = 4_000;
const MAX_HISTORY_OUTPUT_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_OUTPUT_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_ORIGINATOR_CACHE_ENTRIES = 2_048;
const MAX_ARTIFACT_INDEX_CACHE_ENTRIES = 512;
const MAX_LIVE_ARTIFACT_CACHE_BYTES = 96 * 1024 * 1024;
const MAX_LIVE_ARTIFACT_CACHE_ENTRIES = 16;
const MAX_CODEX_WS_PAYLOAD_BYTES = 256 * 1024 * 1024;
const SHARED_DAEMON_HEARTBEAT_MS = 20_000;
const SHARED_DAEMON_RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_SSE_QUEUE_BYTES = 4 * 1024 * 1024;
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
const historyOutputCache = new Map();
const originatorCache = new Map();
const artifactIndexCache = new Map();
const liveArtifacts = new Map();
const sessionsRoot = join(codexHome, "sessions");
const authStore = new TrustedDeviceStore({ passwordFile, sessionFile });
const loginRateLimiter = new LoginRateLimiter();
const globalLoginRateLimiter = new LoginRateLimiter({ maxFailures: 100, maxKeys: 1 });
let historyOutputCacheBytes = 0;
let liveArtifactCacheBytes = 0;
const GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
const MAX_GOAL_OBJECTIVE_LENGTH = 4_000;

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function lruGet(cache, key) {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function lruSet(cache, key, value, maxEntries) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

function closeSseClient(response, { destroy = false } = {}) {
  const client = sseClients.get(response);
  if (!client) return;
  client.closed = true;
  sseClients.delete(response);
  if (client.onDrain) response.off("drain", client.onDrain);
  if (destroy) response.destroy();
  else if (!response.writableEnded) response.end();
}

function queueSseFrame(response, client, frame) {
  if (client.closed || response.writableEnded) return;
  if (client.backpressured) {
    client.queue.push(frame);
    client.queuedBytes += Buffer.byteLength(frame);
    if (client.queuedBytes > MAX_SSE_QUEUE_BYTES) closeSseClient(response, { destroy: true });
    return;
  }
  try {
    if (!response.write(frame)) client.backpressured = true;
  } catch {
    closeSseClient(response, { destroy: true });
  }
}

function flushSseClient(response, client) {
  if (client.closed || response.writableEnded) return;
  client.backpressured = false;
  while (client.queue.length) {
    const frame = client.queue.shift();
    client.queuedBytes -= Buffer.byteLength(frame);
    try {
      if (!response.write(frame)) {
        client.backpressured = true;
        return;
      }
    } catch {
      closeSseClient(response, { destroy: true });
      return;
    }
  }
}

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [response, client] of sseClients) {
    queueSseFrame(response, client, frame);
  }
}

function closeDeviceStreams(deviceId) {
  if (!deviceId) return;
  for (const [response, client] of sseClients) {
    if (client.deviceId !== deviceId) continue;
    closeSseClient(response);
  }
}

function closeOtherDeviceStreams(currentDeviceId) {
  for (const [response, client] of sseClients) {
    if (client.deviceId && client.deviceId === currentDeviceId) continue;
    closeSseClient(response);
  }
}

function liveArtifactKey(threadId, artifactId) {
  return `${threadId}:${artifactId}`;
}

function deleteLiveArtifact(key) {
  const existing = liveArtifacts.get(key);
  if (!existing) return false;
  liveArtifactCacheBytes -= existing.encodedBytes || 0;
  liveArtifacts.delete(key);
  return true;
}

function pruneLiveArtifacts() {
  while (
    liveArtifacts.size > MAX_LIVE_ARTIFACT_CACHE_ENTRIES
    || liveArtifactCacheBytes > MAX_LIVE_ARTIFACT_CACHE_BYTES
  ) {
    deleteLiveArtifact(liveArtifacts.keys().next().value);
  }
}

function registerLiveArtifact(threadId, turnId, item) {
  if (!threadId || item?.type !== "imageGeneration" || !item.result) return null;
  const metadata = normalizeImageArtifact(item, { turnId });
  if (!metadata) return null;
  const key = liveArtifactKey(threadId, metadata.id);
  const result = String(item.result);
  deleteLiveArtifact(key);
  const encodedBytes = Buffer.byteLength(result);
  liveArtifacts.set(key, { metadata, result, encodedBytes });
  liveArtifactCacheBytes += encodedBytes;
  pruneLiveArtifacts();
  return metadata;
}

function sanitizeNotificationForBrowser(message) {
  if (!new Set(["item/started", "item/completed"]).has(message?.method)) return message;
  const item = message.params?.item;
  if (item?.type !== "imageGeneration") return message;
  const metadata = registerLiveArtifact(message.params?.threadId, message.params?.turnId, item);
  return {
    ...message,
    params: {
      ...message.params,
      item: {
        ...item,
        result: "",
        artifact: metadata,
      },
    },
  };
}

class CodexAppServer {
  constructor() {
    this.child = null;
    this.socket = null;
    this.socketHeartbeat = null;
    this.socketPongAt = 0;
    this.sharedReconnectTimer = null;
    this.sharedReconnectAttempt = 0;
    this.subscribedThreads = new Set();
    this.subscriptionSettings = new Map();
    this.pending = new Map();
    this.serverRequests = new Map();
    this.nextId = 1;
    this.readyPromise = null;
    this.status = "stopped";
    this.lastError = null;
    this.intentionalStop = false;
    this.recyclePromise = null;
    this.lastSharedErrorLogAt = 0;
    this.suppressedSharedErrorLogs = 0;
  }

  warnSharedError(message) {
    const now = Date.now();
    if (now - this.lastSharedErrorLogAt < 5 * 60 * 1000) {
      this.suppressedSharedErrorLogs += 1;
      return;
    }
    const suffix = this.suppressedSharedErrorLogs
      ? ` (${this.suppressedSharedErrorLogs} repeated messages suppressed)`
      : "";
    console.warn(`[app-server] ${message}${suffix}`);
    this.lastSharedErrorLogAt = now;
    this.suppressedSharedErrorLogs = 0;
  }

  async ensureReady() {
    if (!this.readyPromise) {
      this.readyPromise = this.start().catch((error) => {
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }

  async start() {
    this.status = "starting";
    this.lastError = null;
    this.intentionalStop = false;
    if (this.sharedReconnectTimer) clearTimeout(this.sharedReconnectTimer);
    this.sharedReconnectTimer = null;
    broadcast({ kind: "bridge/status", status: this.status });

    if (usesSharedDaemon) {
      await this.startSharedDaemonTransport();
    } else {
      this.startIsolatedTransport();
    }

    await this.requestRaw("initialize", {
      clientInfo: {
        name: "codex_pwa",
        title: "Codex PWA",
        version: APP_VERSION,
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.sharedReconnectAttempt = 0;
    this.status = "ready";
    broadcast({ kind: "bridge/status", status: this.status });
  }

  startIsolatedTransport() {
    const child = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
      cwd: roots[0],
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        console.error(`[app-server] ${message}`);
        broadcast({ kind: "bridge/log", level: "error", message });
      }
    });
    child.on("error", (error) => this.onExit(error));
    child.on("exit", (code, signal) => {
      if (!this.intentionalStop) {
        this.onExit(new Error(`Codex app-server exited (code=${code}, signal=${signal})`));
      }
    });
  }

  async startSharedDaemonTransport() {
    const socket = new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      maxPayload: MAX_CODEX_WS_PAYLOAD_BYTES,
      handshakeTimeout: 5_000,
      createConnection: () => createConnection({ path: daemonSocket }),
    });
    this.socket = socket;
    this.socketPongAt = Date.now();

    socket.on("error", (error) => this.onExit(error, socket));
    socket.on("pong", () => {
      if (this.socket === socket) this.socketPongAt = Date.now();
    });

    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => {
        socket.terminate();
        rejectOpen(new Error(`Timed out connecting to shared Codex daemon at ${daemonSocket}`));
      }, 5_000);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("open", handleOpen);
        socket.off("error", handleError);
      };
      const handleOpen = () => {
        cleanup();
        resolveOpen();
      };
      const handleError = (error) => {
        cleanup();
        rejectOpen(error);
      };
      socket.once("open", handleOpen);
      socket.once("error", handleError);
    });

    socket._socket?.setKeepAlive?.(true, SHARED_DAEMON_HEARTBEAT_MS);
    this.startSharedHeartbeat(socket);

    socket.on("message", (payload, isBinary) => {
      if (this.socket === socket) this.socketPongAt = Date.now();
      if (!isBinary) this.onLine(payload.toString("utf8"));
    });
    socket.on("close", (code, reason) => {
      if (!this.intentionalStop) {
        this.onExit(new Error(`Shared Codex daemon connection closed (code=${code}, reason=${reason})`), socket);
      }
    });
  }

  startSharedHeartbeat(socket) {
    this.stopSharedHeartbeat();
    this.socketHeartbeat = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.socketPongAt > SHARED_DAEMON_HEARTBEAT_MS * 2.5) {
        console.warn("[app-server] Shared Codex daemon heartbeat timed out; reconnecting");
        socket.terminate();
        return;
      }
      try {
        socket.ping();
      } catch (error) {
        this.onExit(error, socket);
      }
    }, SHARED_DAEMON_HEARTBEAT_MS);
    this.socketHeartbeat.unref?.();
  }

  stopSharedHeartbeat() {
    if (!this.socketHeartbeat) return;
    clearInterval(this.socketHeartbeat);
    this.socketHeartbeat = null;
  }

  scheduleSharedReconnect() {
    if (!usesSharedDaemon || this.intentionalStop || this.sharedReconnectTimer) return;
    const attempt = this.sharedReconnectAttempt++;
    const delay = Math.min(
      SHARED_DAEMON_RECONNECT_MAX_DELAY_MS,
      1_000 * (2 ** Math.min(attempt, 5)),
    );
    this.sharedReconnectTimer = setTimeout(() => {
      this.sharedReconnectTimer = null;
      if (this.intentionalStop || this.status === "ready") return;
      this.ensureReady().catch((error) => {
        this.warnSharedError(`Shared Codex daemon reconnect failed: ${error.message}`);
        this.scheduleSharedReconnect();
      });
    }, delay);
    this.sharedReconnectTimer.unref?.();
  }

  onExit(error, transport = null) {
    if (transport && this.socket !== transport) return;
    if (this.status === "stopped" && this.intentionalStop) return;
    this.stopSharedHeartbeat();
    this.status = "error";
    this.lastError = error.message;
    this.child = null;
    this.socket = null;
    this.readyPromise = null;
    this.subscribedThreads.clear();
    this.subscriptionSettings.clear();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.serverRequests.clear();
    resetThreadOwnership("released");
    this.warnSharedError(error.message);
    broadcast({ kind: "bridge/status", status: this.status, error: error.message });
    this.scheduleSharedReconnect();
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error(`[app-server] Invalid JSON message (${Buffer.byteLength(line)} bytes)`);
      return;
    }

    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        const error = new Error(message.error.message || "Codex app-server request failed");
        error.details = message.error;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      const supportedRequests = new Set([
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
        "tool/requestUserInput",
        "execCommandApproval",
        "applyPatchApproval",
      ]);
      if (!supportedRequests.has(message.method)) {
        this.sendRpcMessage({
          id: message.id,
          error: {
            code: -32601,
            message: `Codex PWA does not support interactive request: ${message.method}`,
          },
        });
        broadcast({
          kind: "bridge/log",
          level: "warning",
          message: `Unsupported interactive request declined: ${message.method}`,
        });
        return;
      }
      const requestId = String(message.id);
      this.serverRequests.set(requestId, {
        id: message.id,
        method: message.method,
        params: message.params || {},
        receivedAt: Date.now(),
      });
      broadcast({
        kind: "app-server/request",
        requestId,
        method: message.method,
        params: message.params || {},
      });
      return;
    }

    if (message.method === "turn/started") {
      const threadId = message.params?.threadId;
      const turnId = message.params?.turn?.id;
      if (threadId && turnId) {
        activeTurns.set(threadId, turnId);
        markThreadOwned(threadId);
      }
    }
    if (message.method === "turn/completed") {
      const threadId = message.params?.threadId;
      if (threadId) {
        activeTurns.delete(threadId);
        scheduleThreadRelease(threadId, AUTO_RELEASE_DELAY_MS, "turn-completed");
      }
    }
    if (message.method === "thread/closed") {
      const threadId = message.params?.threadId;
      if (threadId) {
        this.subscribedThreads.delete(threadId);
        this.subscriptionSettings.delete(threadId);
        forgetThreadOwnership(threadId, "closed");
      }
    }
    broadcast({ kind: "app-server/notification", message: sanitizeNotificationForBrowser(message) });
  }

  requestRaw(method, params = {}) {
    if (!this.isWritable()) {
      return Promise.reject(new Error("Codex app-server is not writable"));
    }
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const mutating = RPC_MUTATION_METHODS.has(method);
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        const error = new Error(mutating
          ? `Codex 已收到 ${method} 请求，但未在限时内确认结果`
          : `Timed out waiting for ${method}`);
        error.statusCode = 504;
        error.details = mutating
          ? { code: "RPC_OUTCOME_UNKNOWN", outcomeUnknown: true, method, requestId: id }
          : { code: "RPC_TIMEOUT", method, requestId: id };
        rejectRequest(error);
      }, mutating ? RPC_MUTATION_TIMEOUT_MS : RPC_READ_TIMEOUT_MS);
      this.pending.set(String(id), {
        resolve: (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      this.sendRpcMessage({ method, id, params });
    });
  }

  async request(method, params = {}) {
    for (let attempt = 0; ; attempt += 1) {
      if (this.recyclePromise) await this.recyclePromise;
      await this.ensureReady();
      try {
        return await this.requestRaw(method, params);
      } catch (error) {
        const overloaded = error?.details?.code === -32001;
        if (!overloaded || !RETRYABLE_RPC_METHODS.has(method) || attempt >= RPC_OVERLOAD_RETRY_LIMIT) {
          throw error;
        }
        const delay = Math.min(2_000, 180 * (2 ** attempt)) + Math.floor(Math.random() * 120);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async recycle(reason = "handoff") {
    if (usesSharedDaemon) return false;
    if (this.recyclePromise) return this.recyclePromise;
    this.recyclePromise = (async () => {
      const child = this.child;
      this.status = "restarting";
      this.intentionalStop = true;
      broadcast({ kind: "bridge/status", status: this.status, reason });

      if (child && !child.killed) {
        await new Promise((resolveExit) => {
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            resolveExit();
          };
          child.once("exit", finish);
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!finished) child.kill("SIGKILL");
          }, 2_000).unref();
          setTimeout(finish, 5_000).unref();
        });
      }

      this.child = null;
      this.readyPromise = null;
      this.pending.clear();
      this.serverRequests.clear();
      resetThreadOwnership("released");
      await this.ensureReady();
    })().finally(() => {
      this.recyclePromise = null;
    });
    return this.recyclePromise;
  }

  notify(method, params = {}) {
    if (!this.isWritable()) throw new Error("Codex app-server is not writable");
    this.sendRpcMessage({ method, params });
  }

  isWritable() {
    return usesSharedDaemon
      ? this.socket?.readyState === WebSocket.OPEN
      : Boolean(this.child?.stdin?.writable);
  }

  sendRpcMessage(message) {
    if (usesSharedDaemon) {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        throw new Error("Shared Codex daemon connection is not writable");
      }
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not writable");
    writeJsonLine(this.child.stdin, message);
  }

  respondToServerRequest(requestId, result) {
    const pending = this.serverRequests.get(String(requestId));
    if (!pending) throw new Error("Approval request no longer exists");
    this.sendRpcMessage({ id: pending.id, result });
    this.serverRequests.delete(String(requestId));
  }

  rejectServerRequest(requestId, code, message) {
    const pending = this.serverRequests.get(String(requestId));
    if (!pending) throw new Error("Server request no longer exists");
    this.sendRpcMessage({ id: pending.id, error: { code, message } });
    this.serverRequests.delete(String(requestId));
  }

  stop() {
    this.intentionalStop = true;
    this.status = "stopped";
    if (this.sharedReconnectTimer) clearTimeout(this.sharedReconnectTimer);
    this.sharedReconnectTimer = null;
    this.stopSharedHeartbeat();
    this.subscribedThreads.clear();
    this.subscriptionSettings.clear();
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    if (this.socket) this.socket.close(1000, "Codex PWA stopped");
    this.child = null;
    this.socket = null;
    this.readyPromise = null;
  }
}

const codex = new CodexAppServer();

function clearThreadReleaseTimer(threadId) {
  const timer = releaseTimers.get(threadId);
  if (timer) clearTimeout(timer);
  releaseTimers.delete(threadId);
}

function resetThreadOwnership(status = null) {
  const threadIds = new Set([...ownedThreads, ...releasingThreads]);
  for (const timer of releaseTimers.values()) clearTimeout(timer);
  releaseTimers.clear();
  if (recycleRetryTimer) clearTimeout(recycleRetryTimer);
  recycleRetryTimer = null;
  activeTurns.clear();
  ownedThreads.clear();
  releasingThreads.clear();
  if (status) {
    for (const threadId of threadIds) {
      broadcast({ kind: "bridge/threadOwnership", threadId, status });
    }
  }
}

function markThreadOwned(threadId) {
  if (!threadId) return;
  clearThreadReleaseTimer(threadId);
  releasingThreads.delete(threadId);
  ownedThreads.add(threadId);
  broadcast({ kind: "bridge/threadOwnership", threadId, status: "owned" });
}

function forgetThreadOwnership(threadId, status = "released") {
  clearThreadReleaseTimer(threadId);
  activeTurns.delete(threadId);
  ownedThreads.delete(threadId);
  releasingThreads.delete(threadId);
  broadcast({ kind: "bridge/threadOwnership", threadId, status });
}

function hasPendingThreadRequest(threadId) {
  return [...codex.serverRequests.values()].some((request) => request.params?.threadId === threadId);
}

function scheduleBridgeRecycle(reason = "handoff", delay = 750) {
  if (recycleRetryTimer) clearTimeout(recycleRetryTimer);
  recycleRetryTimer = setTimeout(() => {
    recycleRetryTimer = null;
    maybeRecycleBridge(reason).catch((error) => {
      console.warn(`[app-server] Unable to recycle bridge: ${error.message}`);
      scheduleBridgeRecycle(reason, 2_000);
    });
  }, delay);
}

async function maybeRecycleBridge(reason = "handoff") {
  if (usesSharedDaemon) return false;
  if (!releasingThreads.size) return false;
  if (activeTurns.size || codex.serverRequests.size || codex.pending.size || codex.recyclePromise) {
    scheduleBridgeRecycle(reason);
    return false;
  }
  await codex.recycle(reason);
  return true;
}

async function releaseThread(threadId, { reason = "manual", automatic = false } = {}) {
  clearThreadReleaseTimer(threadId);
  if (!ownedThreads.has(threadId)) {
    const recycled = releasingThreads.has(threadId) ? await maybeRecycleBridge(reason) : false;
    return { status: recycled ? "released" : releasingThreads.has(threadId) ? "releasing" : "notOwned", reason };
  }
  if (activeTurns.has(threadId) || hasPendingThreadRequest(threadId)) {
    if (automatic) {
      scheduleThreadRelease(threadId, 2_000, reason);
      return { status: "deferred", reason };
    }
    const error = new Error("Task is still running or waiting for your input");
    error.statusCode = 409;
    throw error;
  }

  releasingThreads.add(threadId);
  broadcast({ kind: "bridge/threadOwnership", threadId, status: "releasing", reason });
  try {
    const result = await codex.request("thread/unsubscribe", { threadId });
    if (usesSharedDaemon) {
      codex.subscribedThreads.delete(threadId);
      codex.subscriptionSettings.delete(threadId);
      forgetThreadOwnership(threadId, "released");
      return {
        status: "released",
        unsubscribeStatus: result?.status || "unsubscribed",
        reason,
      };
    }
    ownedThreads.delete(threadId);
    const recycled = await maybeRecycleBridge(reason);
    return {
      status: recycled ? "released" : "deferred",
      unsubscribeStatus: result?.status || "unsubscribed",
      reason,
    };
  } catch (error) {
    releasingThreads.delete(threadId);
    ownedThreads.add(threadId);
    broadcast({ kind: "bridge/threadOwnership", threadId, status: "owned", error: error.message });
    throw error;
  }
}

function scheduleThreadRelease(threadId, delay = AUTO_RELEASE_DELAY_MS, reason = "idle") {
  if (!threadId || !ownedThreads.has(threadId)) return;
  clearThreadReleaseTimer(threadId);
  releaseTimers.set(threadId, setTimeout(() => {
    releaseTimers.delete(threadId);
    releaseThread(threadId, { reason, automatic: true }).catch((error) => {
      console.warn(`[app-server] Unable to release thread ${threadId}: ${error.message}`);
    });
  }, delay));
}

function isAllowedPath(candidate) {
  return isPathWithinRoots(candidate, roots);
}

async function isAllowedThreadPath(candidate) {
  return isCanonicalPathWithinRoots(candidate, roots, { allowMissing: true });
}

async function resolveAllowedDirectory(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 8_192 || !isAbsolute(candidate)) {
    throw uploadError("Working directory must be an absolute Linux path");
  }
  if (!isAllowedPath(candidate)) throw uploadError("Working directory is outside the allowed roots", 403);
  let actual;
  try {
    actual = await realpath(candidate);
  } catch (error) {
    if (error.code === "ENOENT") throw uploadError("Working directory does not exist", 404);
    if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
    throw error;
  }
  if (!isAllowedPath(actual)) throw uploadError("Resolved directory is outside the allowed roots", 403);
  const details = await stat(actual);
  if (!details.isDirectory()) throw uploadError("Working directory is not a directory");
  return actual;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, value, headers = {}) {
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
  sendJson(response, statusCode, {
    error: error.message || "Unexpected error",
    details: error.details || null,
  });
}

function sendUnauthorized(response) {
  sendJson(response, 401, { error: "请先登录 Codex Remote", authRequired: true });
}

function requestDeviceToken(request) {
  return parseCookies(request.headers.cookie || "")[DEVICE_COOKIE] || "";
}

async function authenticateRequest(request) {
  if (!authStore.enabled) return { kind: "disabled", session: { authenticated: true, csrfToken: null } };
  const token = requestDeviceToken(request);
  const session = await authStore.authenticateToken(token);
  return session ? { kind: "session", token, session } : null;
}

function requireCsrf(request, authentication) {
  if (!isUnsafeMethod(request.method) || authentication?.kind !== "session") return;
  if (!authStore.csrfMatches(authentication.session, request.headers["x-codex-pwa-csrf"])) {
    const error = new Error("安全令牌已失效，请刷新页面后重试");
    error.statusCode = 403;
    throw error;
  }
}

function deviceLabel(userAgent) {
  const value = String(userAgent || "");
  if (/android/i.test(value)) return "Android 手机";
  if (/iphone|ipad/i.test(value)) return "iPhone / iPad";
  if (/windows/i.test(value)) return "Windows 浏览器";
  if (/macintosh|mac os/i.test(value)) return "Mac 浏览器";
  return "浏览器设备";
}

function loginRateLimitKey(request, username) {
  const address = String(request.socket?.remoteAddress || "unknown").slice(0, 128);
  const userAgent = String(request.headers["user-agent"] || "unknown").slice(0, 500);
  return `${address}\n${userAgent}\n${String(username || "").slice(0, 120)}`;
}

async function handleAuthApi(request, response, url) {
  if (url.pathname === "/api/health" && request.method === "GET") {
    const ready = codex.status === "ready";
    sendJson(response, ready ? 200 : 503, { ok: ready, bridge: codex.status });
    return true;
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    if (!authStore.enabled) {
      sendJson(response, 200, { authenticated: true, authEnabled: false, csrfToken: null });
      return true;
    }
    const body = await readBody(request);
    const username = String(body.username || "").slice(0, 120);
    const limiterKey = loginRateLimitKey(request, username);
    const retryAfter = Math.max(
      loginRateLimiter.retryAfterSeconds(limiterKey),
      globalLoginRateLimiter.retryAfterSeconds("instance"),
    );
    if (retryAfter) {
      sendJson(response, 429, { error: `登录尝试过多，请在 ${retryAfter} 秒后重试` }, { "retry-after": retryAfter });
      return true;
    }
    const password = String(body.password || "").slice(0, 4_096);
    if (!(await authStore.verifyCredentials(username, password))) {
      loginRateLimiter.recordFailure(limiterKey);
      globalLoginRateLimiter.recordFailure("instance");
      sendJson(response, 401, { error: "用户名或密码不正确", authRequired: true });
      return true;
    }
    loginRateLimiter.reset(limiterKey);
    const remember = body.remember !== false;
    const userAgent = request.headers["user-agent"] || "";
    const created = await authStore.createSession({
      remember,
      userAgent,
      label: String(body.deviceLabel || deviceLabel(userAgent)).slice(0, 120),
    });
    sendJson(
      response,
      200,
      { ...created.session, authEnabled: true },
      { "set-cookie": deviceCookie(created.token, { remember }) },
    );
    return true;
  }

  if (url.pathname === "/api/auth/session" && request.method === "GET") {
    const authentication = await authenticateRequest(request);
    if (!authentication) {
      sendUnauthorized(response);
      return true;
    }
    sendJson(response, 200, {
      ...authentication.session,
      authenticated: true,
      authEnabled: authStore.enabled,
    });
    return true;
  }

  if (url.pathname === "/api/auth/devices" && request.method === "GET") {
    const authentication = await authenticateRequest(request);
    if (!authentication) {
      sendUnauthorized(response);
      return true;
    }
    const onlineIds = new Set([...sseClients.values()].map((client) => client.deviceId).filter(Boolean));
    const devices = (await authStore.listSessions(authentication.token || ""))
      .map((device) => ({ ...device, online: onlineIds.has(device.id) }));
    sendJson(response, 200, { devices, currentDeviceId: authentication.session?.id || null });
    return true;
  }

  const deviceMatch = url.pathname.match(/^\/api\/auth\/devices\/([^/]+)$/);
  if (deviceMatch && request.method === "PATCH") {
    const authentication = await authenticateRequest(request);
    if (!authentication) {
      sendUnauthorized(response);
      return true;
    }
    requireCsrf(request, authentication);
    const id = decodeURIComponent(deviceMatch[1]);
    const body = await readBody(request);
    const device = await authStore.renameSession(id, body.label);
    if (!device) {
      sendJson(response, 404, { error: "可信设备不存在或已经过期" });
      return true;
    }
    sendJson(response, 200, { device });
    return true;
  }

  if (deviceMatch && request.method === "DELETE") {
    const authentication = await authenticateRequest(request);
    if (!authentication) {
      sendUnauthorized(response);
      return true;
    }
    requireCsrf(request, authentication);
    const id = decodeURIComponent(deviceMatch[1]);
    const revoked = await authStore.revokeSession(id);
    if (!revoked) {
      sendJson(response, 404, { error: "可信设备不存在或已经过期" });
      return true;
    }
    closeDeviceStreams(id);
    const current = authentication.session?.id === id;
    sendJson(
      response,
      200,
      { ok: true, current },
      current ? { "set-cookie": deviceCookie("", { clear: true }) } : {},
    );
    return true;
  }

  if (url.pathname === "/api/auth/logout-others" && request.method === "POST") {
    const authentication = await authenticateRequest(request);
    if (!authentication) {
      sendUnauthorized(response);
      return true;
    }
    requireCsrf(request, authentication);
    const currentId = authentication.session?.id || "";
    const revokedIds = await authStore.revokeOthers(currentId);
    for (const id of revokedIds) closeDeviceStreams(id);
    closeOtherDeviceStreams(currentId);
    sendJson(response, 200, { ok: true, revoked: revokedIds.length });
    return true;
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const authentication = await authenticateRequest(request);
    if (!authentication) {
      sendUnauthorized(response);
      return true;
    }
    requireCsrf(request, authentication);
    if (authentication.kind === "session") {
      await authStore.revokeToken(authentication.token);
      closeDeviceStreams(authentication.session?.id);
    }
    sendJson(response, 200, { ok: true }, { "set-cookie": deviceCookie("", { clear: true }) });
    return true;
  }

  if (url.pathname === "/api/auth/logout-all" && request.method === "POST") {
    const authentication = await authenticateRequest(request);
    if (!authentication) {
      sendUnauthorized(response);
      return true;
    }
    requireCsrf(request, authentication);
    await authStore.revokeAll();
    for (const client of [...sseClients.keys()]) closeSseClient(client);
    sendJson(response, 200, { ok: true }, { "set-cookie": deviceCookie("", { clear: true }) });
    return true;
  }
  return false;
}

async function allowedThread(threadId, includeTurns = false) {
  const result = await codex.request("thread/read", { threadId, includeTurns });
  if (!result?.thread || !await isAllowedThreadPath(result.thread.cwd)) {
    const error = new Error("Thread is outside the allowed roots");
    error.statusCode = 403;
    throw error;
  }
  return result.thread;
}

function isUnsupportedRpcError(error) {
  return error?.details?.code === -32601
    || /method not found|unsupported|unknown method|not implemented/i.test(String(error?.message || ""));
}

async function requestThreadGoal(threadId) {
  try {
    const result = await codex.request("thread/goal/get", { threadId });
    return { supported: true, goal: result?.goal || null };
  } catch (error) {
    if (isUnsupportedRpcError(error)) return { supported: false, goal: null };
    throw error;
  }
}

async function requestThreadGoalBestEffort(threadId) {
  try {
    return await requestThreadGoal(threadId);
  } catch (error) {
    console.warn(`[app-server] Unable to read Goal for ${threadId}: ${error.message}`);
    return { supported: null, goal: null, error: error.message };
  }
}

function goalUnsupportedError() {
  const error = new Error("当前 Codex app-server 不支持 Goal 管理，请升级 Codex CLI 后重试");
  error.statusCode = 501;
  return error;
}

function goalSetParams(threadId, body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Goal settings must be an object");
  }
  const params = { threadId };
  if (Object.hasOwn(body, "objective")) {
    if (body.objective === null) {
      params.objective = null;
    } else {
      const objective = String(body.objective || "").trim();
      if (!objective) throw new Error("Goal objective cannot be empty");
      if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
        throw new Error(`Goal objective is limited to ${MAX_GOAL_OBJECTIVE_LENGTH} characters`);
      }
      params.objective = objective;
    }
  }
  if (Object.hasOwn(body, "status")) {
    if (body.status === null) {
      params.status = null;
    } else {
      const status = String(body.status || "");
      if (!GOAL_STATUSES.has(status)) throw new Error("Unsupported Goal status");
      params.status = status;
    }
  }
  if (Object.hasOwn(body, "tokenBudget")) {
    if (body.tokenBudget === null || body.tokenBudget === "") {
      params.tokenBudget = null;
    } else {
      const tokenBudget = Number(body.tokenBudget);
      if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) {
        throw new Error("Goal token budget must be a non-negative integer");
      }
      params.tokenBudget = tokenBudget;
    }
  }
  if (Object.keys(params).length === 1) throw new Error("Goal update is empty");
  return params;
}

function historyPageLimit(value) {
  const parsed = Number.parseInt(String(value || HISTORY_PAGE_SIZE), 10);
  if (!Number.isFinite(parsed)) return HISTORY_PAGE_SIZE;
  return Math.min(MAX_HISTORY_PAGE_SIZE, Math.max(1, parsed));
}

function collapsedHistoryOutput(value, limit = HISTORY_COMMAND_PREVIEW_CHARS) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  const headLength = Math.floor(limit * 0.68);
  const tailLength = limit - headLength;
  return `${text.slice(0, headLength)}\n\n… ${text.length - limit} 个字符将在展开时载入 …\n\n${text.slice(-tailLength)}`;
}

function cacheHistoryOutput(threadId, itemId, output) {
  if (!threadId || !itemId || !output) return false;
  const key = `${threadId}:${itemId}`;
  const existing = historyOutputCache.get(key);
  if (existing) historyOutputCacheBytes -= existing.bytes;
  const bytes = Buffer.byteLength(output);
  historyOutputCache.delete(key);
  if (bytes > MAX_HISTORY_OUTPUT_ENTRY_BYTES) return false;
  historyOutputCache.set(key, { output, bytes });
  historyOutputCacheBytes += bytes;
  while (historyOutputCacheBytes > MAX_HISTORY_OUTPUT_CACHE_BYTES && historyOutputCache.size) {
    const oldestKey = historyOutputCache.keys().next().value;
    const oldest = historyOutputCache.get(oldestKey);
    historyOutputCache.delete(oldestKey);
    historyOutputCacheBytes -= oldest?.bytes || 0;
  }
  return historyOutputCache.has(key);
}

function compactHistoryTurn(threadId, turn) {
  const items = turn?.items || [];
  const activityIndexes = [];
  items.forEach((item, index) => {
    if (item?.type !== "userMessage" && item?.type !== "agentMessage") activityIndexes.push(index);
  });
  const retainedActivity = new Set(activityIndexes.slice(-HISTORY_ACTIVITY_LIMIT_PER_TURN));
  items.forEach((item, index) => {
    if (item?.type === "fileChange") retainedActivity.add(index);
  });
  const selected = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const isConversation = item?.type === "userMessage" || item?.type === "agentMessage";
    if (!isConversation && !retainedActivity.has(index)) continue;
    if (item?.type === "commandExecution" && String(item.aggregatedOutput || "").length > HISTORY_COMMAND_PREVIEW_CHARS) {
      const output = String(item.aggregatedOutput || "");
      const fullOutputAvailable = cacheHistoryOutput(threadId, item.id, output);
      selected.push({
        ...item,
        aggregatedOutput: collapsedHistoryOutput(output),
        outputTruncated: true,
        fullOutputAvailable,
        outputLength: output.length,
      });
    } else {
      selected.push(item);
    }
  }
  const omittedActivityCount = Math.max(0, activityIndexes.length - retainedActivity.size);
  if (omittedActivityCount) {
    selected.push({
      type: "historyNotice",
      id: `${turn.id}-history-notice`,
      text: `为保证手机流畅，本轮较早的 ${omittedActivityCount.toLocaleString("zh-CN")} 条命令或工具活动未渲染；正文消息和最近活动已保留。`,
    });
  }
  return { ...turn, items: selected, omittedActivityCount };
}

function compactHistoryPage(threadId, page) {
  return {
    ...page,
    data: (page.data || []).map((turn) => compactHistoryTurn(threadId, turn)),
  };
}

async function readThreadTurnsPage(threadId, {
  cursor = null,
  limit = HISTORY_PAGE_SIZE,
  validate = true,
  itemsView = "summary",
  complete = false,
  sortDirection = "desc",
} = {}) {
  if (validate) await allowedThread(threadId, false);
  const direction = sortDirection === "asc" ? "asc" : "desc";
  const result = await codex.request("thread/turns/list", {
    threadId,
    limit: historyPageLimit(limit),
    sortDirection: direction,
    itemsView,
    ...(cursor ? { cursor: String(cursor).slice(0, 2_048) } : {}),
  });
  const page = {
    data: result?.data || [],
    nextCursor: result?.nextCursor || null,
    backwardsCursor: result?.backwardsCursor || null,
    sortDirection: direction,
  };
  return itemsView === "full" && !complete ? compactHistoryPage(threadId, page) : page;
}

async function readActiveNarrative(threadId, activeTurnId) {
  if (!activeTurnId) return null;
  const result = await codex.request("thread/turns/list", {
    threadId,
    limit: 1,
    sortDirection: "desc",
    itemsView: "full",
  });
  const page = narrativeHistoryPage({
    data: result?.data || [],
    nextCursor: null,
    backwardsCursor: result?.backwardsCursor || null,
  });
  return page.data.find((turn) => turn?.id === activeTurnId) || null;
}

function syncActiveTurnFromHistory(threadId, history, threadStatus) {
  const activeTurn = (history?.data || []).find((turn) => turn?.status === "inProgress");
  if (activeTurn?.id) {
    activeTurns.set(threadId, activeTurn.id);
  } else if (threadStatus?.type !== "active") {
    activeTurns.delete(threadId);
  }
  return activeTurn?.id || null;
}

async function subscribeThread(threadId, fallbackThread) {
  clearThreadReleaseTimer(threadId);
  if (usesSharedDaemon && codex.subscribedThreads.has(threadId)) {
    return {
      thread: fallbackThread,
      settings: codex.subscriptionSettings.get(threadId) || null,
    };
  }
  let result;
  try {
    result = await codex.request("thread/resume", { threadId, excludeTurns: true });
  } catch (error) {
    const details = `${error?.message || ""} ${JSON.stringify(error?.details || {})}`;
    if (error?.details?.code !== -32602 || !/excludeTurns|unknown field/i.test(details)) throw error;
    result = await codex.request("thread/resume", { threadId });
  }
  if (usesSharedDaemon) {
    codex.subscribedThreads.add(threadId);
    codex.subscriptionSettings.set(threadId, serializeThreadSettings(result || {}));
  }
  markThreadOwned(threadId);
  return {
    thread: result?.thread || fallbackThread,
    settings: serializeThreadSettings(result || {}),
  };
}

function serializeThread(thread) {
  return {
    id: thread.id,
    name: thread.name,
    preview: thread.preview?.slice(0, 360) || "",
    cwd: thread.cwd,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.recencyAt,
    status: thread.status,
    source: thread.source,
    threadSource: thread.threadSource,
    parentThreadId: thread.parentThreadId,
    forkedFromId: thread.forkedFromId,
    agentNickname: thread.agentNickname,
    agentRole: thread.agentRole,
    gitInfo: thread.gitInfo,
    cliVersion: thread.cliVersion,
    canAcceptDirectInput: thread.canAcceptDirectInput,
    isPinned: Boolean(thread.isPinned),
  };
}

async function readThreadOriginator(thread) {
  if (!thread?.path || thread.threadSource === "codex-pwa-mobile") return "";
  let actualPath;
  let actualSessionsRoot;
  try {
    [actualPath, actualSessionsRoot] = await Promise.all([realpath(thread.path), realpath(sessionsRoot)]);
  } catch {
    return "";
  }
  if (!isPathWithinRoots(actualPath, [actualSessionsRoot])) return "";
  if (originatorCache.has(actualPath)) return lruGet(originatorCache, actualPath);
  const details = await stat(actualPath);

  const handle = await open(actualPath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, details.size)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const parsed = JSON.parse(firstLine || "{}");
    const originator = String(parsed?.payload?.originator || "").slice(0, 120);
    lruSet(originatorCache, actualPath, originator, MAX_ORIGINATOR_CACHE_ENTRIES);
    return originator;
  } catch {
    lruSet(originatorCache, actualPath, "", MAX_ORIGINATOR_CACHE_ENTRIES);
    return "";
  } finally {
    await handle.close();
  }
}

async function serializeThreadWithOrigin(thread) {
  const originator = await readThreadOriginator(thread);
  return {
    ...serializeThread(thread),
    clientOrigin: inferClientOrigin(thread, originator),
  };
}

async function resolveThreadRollout(thread) {
  const candidate = String(thread?.path || "");
  if (!candidate || !isAbsolute(candidate) || extname(candidate) !== ".jsonl") return null;
  let actual;
  try { actual = await realpath(candidate); } catch { return null; }
  if (!isPathWithinRoots(actual, [codexHome])) return null;
  const details = await stat(actual);
  return details.isFile() ? { actual, details } : null;
}

function publicArtifact(threadId, artifact) {
  const base = `/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(artifact.id)}/raw`;
  return {
    ...artifact,
    previewUrl: base,
    downloadUrl: `${base}?download=1`,
  };
}

async function listThreadArtifacts(threadId, thread = null) {
  const allowed = thread || await allowedThread(threadId, false);
  const rollout = await resolveThreadRollout(allowed);
  let artifacts = [];
  if (rollout) {
    const cached = lruGet(artifactIndexCache, rollout.actual);
    const sameFile = cached
      && cached.dev === rollout.details.dev
      && cached.ino === rollout.details.ino;
    if (sameFile && cached.size === rollout.details.size && cached.mtimeMs === rollout.details.mtimeMs) {
      artifacts = cached.artifacts;
    } else {
      const canContinue = sameFile
        && rollout.details.size >= cached.scannedBytes
        && rollout.details.size > cached.size;
      const scan = await scanRolloutArtifacts(rollout.actual, canContinue
        ? {
            start: cached.scannedBytes,
            artifacts: cached.artifacts,
            activeTurnId: cached.activeTurnId,
          }
        : {});
      artifacts = scan.artifacts;
      lruSet(artifactIndexCache, rollout.actual, {
        size: scan.size,
        mtimeMs: scan.mtimeMs,
        dev: scan.dev,
        ino: scan.ino,
        artifacts,
        activeTurnId: scan.activeTurnId,
        scannedBytes: scan.scannedBytes,
      }, MAX_ARTIFACT_INDEX_CACHE_ENTRIES);
    }
    for (const artifact of artifacts) deleteLiveArtifact(liveArtifactKey(threadId, artifact.id));
  }
  const merged = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const [key, live] of liveArtifacts) {
    if (!key.startsWith(`${threadId}:`)) continue;
    merged.set(live.metadata.id, live.metadata);
  }
  return [...merged.values()]
    .sort((left, right) => String(left.timestamp || "").localeCompare(String(right.timestamp || "")))
    .map((artifact) => publicArtifact(threadId, artifact));
}

async function readThreadArtifact(threadId, artifactId) {
  const live = liveArtifacts.get(liveArtifactKey(threadId, artifactId));
  if (live) {
    const value = live.result.startsWith("data:") ? live.result.slice(live.result.indexOf(",") + 1) : live.result;
    const buffer = Buffer.from(value.replace(/\s+/g, ""), "base64");
    if (buffer.length && buffer.length <= MAX_ARTIFACT_BYTES) return { metadata: live.metadata, buffer };
  }
  const thread = await allowedThread(threadId, false);
  const rollout = await resolveThreadRollout(thread);
  return rollout ? readRolloutArtifact(rollout.actual, artifactId) : null;
}

async function sendThreadArtifact(request, response, threadId, artifactId, url) {
  const artifact = await readThreadArtifact(threadId, artifactId);
  if (!artifact) {
    const error = new Error("Generated artifact was not found");
    error.statusCode = 404;
    throw error;
  }
  const download = url.searchParams.get("download") === "1";
  response.writeHead(200, {
    "cache-control": "private, no-store",
    "content-disposition": contentDisposition(artifact.metadata.name, download),
    "content-length": artifact.buffer.length,
    "content-security-policy": "sandbox",
    "content-type": artifact.metadata.mimeType,
  });
  if (request.method === "HEAD") response.end();
  else response.end(artifact.buffer);
}

function initialThreadName(prompt) {
  const singleLine = String(prompt || "").replace(/\s+/g, " ").trim();
  if (singleLine.length <= 88) return singleLine;
  return `${singleLine.slice(0, 87).trimEnd()}…`;
}

async function resolveAllowedFile(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 8_192 || !isAbsolute(candidate)) {
    const error = new Error("File path must be an absolute Linux path");
    error.statusCode = 400;
    throw error;
  }
  if (!isAllowedPath(candidate)) {
    const error = new Error("File is outside the allowed roots");
    error.statusCode = 403;
    throw error;
  }

  let actual;
  try {
    actual = await realpath(candidate);
  } catch {
    const error = new Error("File not found");
    error.statusCode = 404;
    throw error;
  }
  if (!isAllowedPath(actual)) {
    const error = new Error("Resolved file is outside the allowed roots");
    error.statusCode = 403;
    throw error;
  }
  const details = await stat(actual);
  if (!details.isFile()) {
    const error = new Error("Path is not a regular file");
    error.statusCode = 400;
    throw error;
  }
  return { actual, details, presentation: filePresentation(actual) };
}

async function sendAllowedFile(request, response, url) {
  const { actual, details, presentation } = await resolveAllowedFile(url.searchParams.get("path") || "");
  const range = parseByteRange(request.headers.range, details.size);
  const download = url.searchParams.get("download") === "1" || !presentation.inline;
  const commonHeaders = {
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-disposition": contentDisposition(actual, download),
    "content-type": presentation.mimeType,
    "last-modified": details.mtime.toUTCString(),
    "content-security-policy": "sandbox",
  };

  if (range.kind === "invalid") {
    response.writeHead(416, { ...commonHeaders, "content-range": `bytes */${details.size}` });
    response.end();
    return;
  }

  const start = range.kind === "range" ? range.start : 0;
  const end = range.kind === "range" ? range.end : Math.max(0, details.size - 1);
  const length = details.size === 0 ? 0 : end - start + 1;
  response.writeHead(range.kind === "range" ? 206 : 200, {
    ...commonHeaders,
    "content-length": length,
    ...(range.kind === "range" ? { "content-range": `bytes ${start}-${end}/${details.size}` } : {}),
  });
  if (request.method === "HEAD" || details.size === 0) {
    response.end();
    return;
  }
  createReadStream(actual, { start, end })
    .on("error", () => response.destroy())
    .pipe(response);
}

function uploadError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function resolveUploadDirectory(url) {
  const threadId = String(url.searchParams.get("threadId") || "").trim();
  const cwd = String(url.searchParams.get("cwd") || "").trim();
  if (threadId && cwd) throw uploadError("Choose either threadId or cwd, not both");
  if (threadId) {
    const thread = await allowedThread(threadId, false);
    return resolveAllowedDirectory(thread.cwd);
  }
  if (cwd) return resolveAllowedDirectory(cwd);
  throw uploadError("An existing task or working directory is required");
}

async function claimUploadedFile(tempPath, directory, filename) {
  for (let number = 0; number < 10_000; number += 1) {
    const destination = join(directory, numberedUploadFilename(filename, number));
    try {
      await link(tempPath, destination);
      try {
        await unlink(tempPath);
      } catch (error) {
        await unlink(destination).catch(() => {});
        throw error;
      }
      return destination;
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw uploadError(`Unable to find an unused filename for ${filename}`, 409);
}

async function receiveUploadedFiles(request, directory) {
  if (request.headers["x-codex-pwa-upload"] !== "1") {
    throw uploadError("Missing upload request marker", 403);
  }
  const declaredSize = Number.parseInt(request.headers["content-length"] || "0", 10);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BATCH_SIZE + 2 * 1024 * 1024) {
    throw uploadError("Upload batch is larger than 512 MB", 413);
  }

  let parser;
  try {
    parser = Busboy({
      headers: request.headers,
      defParamCharset: "utf8",
      limits: {
        files: MAX_UPLOAD_FILES,
        fileSize: MAX_UPLOAD_FILE_SIZE,
        fields: 0,
        parts: MAX_UPLOAD_FILES,
      },
    });
  } catch {
    throw uploadError("Upload must use multipart/form-data");
  }

  let totalBytes = 0;
  let fileCount = 0;
  const tempPaths = new Set();
  const createdPaths = new Set();
  const tasks = [];

  parser.on("file", (fieldName, stream, info) => {
    if (fieldName !== "files") {
      stream.resume();
      return;
    }
    fileCount += 1;
    const filename = safeUploadFilename(info.filename);
    const tempPath = join(directory, `.codex-pwa-upload-${randomUUID()}.part`);
    tempPaths.add(tempPath);
    const task = (async () => {
      let fileBytes = 0;
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          fileBytes += chunk.length;
          totalBytes += chunk.length;
          if (totalBytes > MAX_UPLOAD_BATCH_SIZE) {
            callback(uploadError("Upload batch is larger than 512 MB", 413));
          } else {
            callback(null, chunk);
          }
        },
      });
      try {
        await pipeline(stream, meter, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
        if (stream.truncated) throw uploadError(`${filename} is larger than 256 MB`, 413);
        const destination = await claimUploadedFile(tempPath, directory, filename);
        tempPaths.delete(tempPath);
        createdPaths.add(destination);
        return {
          name: destination.split(sep).at(-1),
          originalName: filename,
          relativePath: relative(directory, destination).split(sep).join("/"),
          size: fileBytes,
          mimeType: info.mimeType || "application/octet-stream",
          previewUrl: `/file-preview.html?path=${encodeURIComponent(destination)}`,
        };
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        tempPaths.delete(tempPath);
        throw error;
      }
    })();
    tasks.push(task);
  });

  const parseResult = await new Promise((resolve) => {
    let failure = null;
    parser.once("filesLimit", () => { failure ||= uploadError("A batch can contain at most 20 files", 413); });
    parser.once("partsLimit", () => { failure ||= uploadError("Upload contains too many parts", 413); });
    parser.once("error", (error) => { failure ||= error; resolve(failure); });
    parser.once("close", () => resolve(failure));
    request.once("aborted", () => parser.destroy(uploadError("Upload was cancelled", 499)));
    request.pipe(parser);
  });

  const settled = await Promise.allSettled(tasks);
  const taskFailure = settled.find((result) => result.status === "rejected")?.reason;
  const failure = parseResult || taskFailure || (fileCount === 0 ? uploadError("Choose at least one file") : null);
  if (failure) {
    await Promise.all([
      ...[...tempPaths].map((path) => unlink(path).catch(() => {})),
      ...[...createdPaths].map((path) => unlink(path).catch(() => {})),
    ]);
    throw failure;
  }
  return settled.map((result) => result.value);
}

async function listDirectories(candidate, showHidden = false, query = "") {
  const directory = await resolveAllowedDirectory(candidate || roots[0]);
  let dirents;
  try {
    dirents = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
    throw error;
  }
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase("zh-CN").slice(0, 160);
  const allDirectories = dirents
    .filter((entry) => entry.isDirectory() && (showHidden || !entry.name.startsWith(".")))
    .filter((entry) => !normalizedQuery || entry.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
  const breadcrumbs = directoryBreadcrumbs(directory, roots);
  return {
    path: directory,
    name: basename(directory) || directory,
    parent: breadcrumbs.length > 1 ? dirname(directory) : null,
    breadcrumbs,
    roots: roots.map((root) => ({ name: basename(root) || root, path: root })),
    entries: allDirectories.slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => ({
      name: entry.name,
      path: join(directory, entry.name),
      hidden: entry.name.startsWith("."),
    })),
    truncated: allDirectories.length > MAX_DIRECTORY_ENTRIES,
  };
}

async function listFiles(candidate, { showHidden = false, query = "" } = {}) {
  const directory = await resolveAllowedDirectory(candidate || roots[0]);
  let dirents;
  try {
    dirents = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
    throw error;
  }
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase("zh-CN").slice(0, 160);
  const eligible = dirents
    .filter((entry) => (entry.isDirectory() || entry.isFile()) && (showHidden || !entry.name.startsWith(".")))
    .filter((entry) => !normalizedQuery || entry.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    .sort((left, right) => {
      const typeDelta = Number(right.isDirectory()) - Number(left.isDirectory());
      return typeDelta || left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
    });
  const selected = eligible.slice(0, MAX_DIRECTORY_ENTRIES);
  const entries = (await Promise.all(selected.map(async (entry) => {
    const path = join(directory, entry.name);
    try {
      const details = await stat(path);
      if (entry.isDirectory() && !details.isDirectory()) return null;
      if (entry.isFile() && !details.isFile()) return null;
      const presentation = entry.isFile() ? filePresentation(path) : null;
      return {
        name: entry.name,
        path,
        type: entry.isDirectory() ? "directory" : "file",
        hidden: entry.name.startsWith("."),
        size: entry.isFile() ? details.size : null,
        modifiedAt: details.mtimeMs,
        mimeType: presentation?.mimeType || null,
        previewKind: presentation?.previewKind || null,
      };
    } catch (error) {
      if (new Set(["ENOENT", "EACCES", "EPERM"]).has(error.code)) return null;
      throw error;
    }
  }))).filter(Boolean);
  const breadcrumbs = directoryBreadcrumbs(directory, roots);
  return {
    path: directory,
    name: basename(directory) || directory,
    parent: breadcrumbs.length > 1 ? dirname(directory) : null,
    breadcrumbs,
    roots: roots.map((root) => ({ name: basename(root) || root, path: root })),
    entries,
    truncated: eligible.length > MAX_DIRECTORY_ENTRIES,
  };
}

async function createDirectory(request) {
  if (request.headers["x-codex-pwa-directory"] !== "1") {
    throw uploadError("Missing directory request marker", 403);
  }
  const body = await readBody(request);
  const parent = await resolveAllowedDirectory(String(body.parent || ""));
  const validation = validateDirectoryName(body.name);
  if (!validation.ok) throw uploadError(validation.error);
  const candidate = join(parent, validation.name);
  if (!isAllowedPath(candidate)) throw uploadError("Directory is outside the allowed roots", 403);
  try {
    await mkdir(candidate, { mode: 0o750 });
    await chmod(candidate, 0o750);
  } catch (error) {
    if (error.code === "EEXIST") throw uploadError("A file or directory with this name already exists", 409);
    if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
    throw error;
  }
  const actual = await resolveAllowedDirectory(candidate);
  return { name: basename(actual), path: actual, parent };
}

function validateEntryName(value) {
  const name = String(value || "").normalize("NFC").trim();
  if (!name) throw uploadError("文件名不能为空");
  if (name === "." || name === "..") throw uploadError("文件名不能是 . 或 ..");
  if (/[\\/]/.test(name)) throw uploadError("文件名不能包含斜杠");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw uploadError("文件名包含控制字符");
  if (Buffer.byteLength(name) > 240) throw uploadError("文件名过长");
  return name;
}

async function resolveMutationSource(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 8_192 || !isAbsolute(candidate)) {
    throw uploadError("操作路径必须是绝对 Linux 路径");
  }
  if (!isAllowedPath(candidate)) throw uploadError("操作路径位于授权根目录之外", 403);
  let details;
  try {
    details = await lstat(candidate);
  } catch (error) {
    if (error.code === "ENOENT") throw uploadError("操作目标不存在", 404);
    if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
    throw error;
  }
  if (details.isSymbolicLink()) throw uploadError("为安全起见，不允许操作符号链接", 403);
  if (!details.isFile() && !details.isDirectory()) throw uploadError("只支持普通文件和目录");
  const actual = await realpath(candidate);
  if (!isAllowedPath(actual)) throw uploadError("解析后的操作目标位于授权根目录之外", 403);
  return { actual, details };
}

async function assertDestinationAbsent(destination) {
  try {
    await lstat(destination);
    throw uploadError("目标位置已经存在同名文件或目录", 409);
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code !== "ENOENT") {
      if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
      throw error;
    }
  }
}

function temporaryOperationPath(path, operation) {
  return join(dirname(path), `.${basename(path)}.codex-pwa-${operation}-${randomUUID()}`);
}

async function copyToFinalPath(source, destination, { recursive }) {
  const temporary = temporaryOperationPath(destination, "copying");
  try {
    await cp(source, temporary, { recursive, errorOnExist: true, force: false });
    await assertDestinationAbsent(destination);
    if (recursive) {
      await rename(temporary, destination);
    } else {
      await link(temporary, destination);
      await unlink(temporary).catch((error) => {
        console.warn(`[files] Copied file is ready, but temporary link cleanup failed at ${temporary}: ${error.message}`);
      });
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function moveAcrossFilesystems(source, destination, details) {
  await copyToFinalPath(source, destination, { recursive: details.isDirectory() });
  const retiredSource = temporaryOperationPath(source, "moved");
  try {
    await rename(source, retiredSource);
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  try {
    await rm(retiredSource, { recursive: details.isDirectory(), force: false });
    return null;
  } catch (error) {
    console.warn(`[files] Move completed, but deferred cleanup remains at ${retiredSource}: ${error.message}`);
    return retiredSource;
  }
}

async function operateOnFile(request) {
  if (request.headers["x-codex-pwa-file-operation"] !== "1") {
    throw uploadError("Missing file operation request marker", 403);
  }
  const body = await readBody(request);
  const operation = String(body.operation || "").trim().toLowerCase();
  if (!["rename", "move", "copy", "delete"].includes(operation)) throw uploadError("不支持的文件操作");
  const source = await resolveMutationSource(String(body.path || ""));
  if (roots.includes(source.actual)) throw uploadError("不能直接操作授权根目录", 403);

  if (operation === "delete") {
    if (source.details.isDirectory()) {
      const children = await readdir(source.actual);
      if (children.length) throw uploadError("为避免误删，不允许删除非空目录", 409);
      await rm(source.actual, { recursive: false });
    } else {
      await unlink(source.actual);
    }
    return { operation, path: source.actual };
  }

  const targetDirectory = operation === "rename"
    ? await resolveAllowedDirectory(dirname(source.actual))
    : await resolveAllowedDirectory(String(body.targetDirectory || ""));
  const name = validateEntryName(body.name || basename(source.actual));
  const destination = join(targetDirectory, name);
  if (!isAllowedPath(destination)) throw uploadError("目标位置位于授权根目录之外", 403);
  if (destination === source.actual) throw uploadError("源路径和目标路径相同");
  if (source.details.isDirectory() && isPathWithinRoots(destination, [source.actual])) {
    throw uploadError("不能把目录移动或复制到自身内部", 409);
  }
  await assertDestinationAbsent(destination);
  let cleanupPending = null;
  try {
    if (operation === "copy") {
      await copyToFinalPath(source.actual, destination, { recursive: source.details.isDirectory() });
    } else {
      try {
        await rename(source.actual, destination);
      } catch (error) {
        if (error.code !== "EXDEV") throw error;
        cleanupPending = await moveAcrossFilesystems(source.actual, destination, source.details);
      }
    }
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") throw uploadError("目标位置已经存在同名文件或目录", 409);
    if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
    throw error;
  }
  return { operation, path: source.actual, targetPath: destination, cleanupPending };
}

async function handleApi(request, response, url, authentication) {
  if (request.method === "GET" && url.pathname === "/api/directories") {
    const result = await listDirectories(
      url.searchParams.get("path") || roots[0],
      url.searchParams.get("hidden") === "true",
      url.searchParams.get("query") || "",
    );
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/directories") {
    const result = await createDirectory(request);
    sendJson(response, 201, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/files/list") {
    const result = await listFiles(url.searchParams.get("path") || roots[0], {
      showHidden: url.searchParams.get("hidden") === "true",
      query: url.searchParams.get("query") || "",
    });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/files/upload") {
    const directory = await resolveUploadDirectory(url);
    const files = await receiveUploadedFiles(request, directory);
    sendJson(response, 201, { cwd: directory, files });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/files/operations") {
    const result = await operateOnFile(request);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/files/meta") {
    const { actual, details, presentation } = await resolveAllowedFile(url.searchParams.get("path") || "");
    sendJson(response, 200, {
      name: actual.split(sep).at(-1),
      size: details.size,
      modifiedAt: details.mtimeMs,
      mimeType: presentation.mimeType,
      previewKind: presentation.previewKind,
    });
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/files/raw") {
    await sendAllowedFile(request, response, url);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    try {
      await codex.ensureReady();
    } catch {}
    sendJson(response, 200, {
      bridge: codex.status,
      appServerMode,
      daemonSocket: usesSharedDaemon ? daemonSocket : null,
      error: codex.lastError,
      roots,
      appRoot: here,
      instanceName,
      networkLabel,
      version: APP_VERSION,
      activeTurns: Object.fromEntries(activeTurns),
      ownedThreads: [...ownedThreads],
      releasingThreads: [...releasingThreads],
      pendingApprovals: [...codex.serverRequests.entries()].map(([requestId, item]) => ({
        requestId,
        method: item.method,
        params: item.params,
      })),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/models") {
    const result = await codex.request("model/list", { limit: 100 });
    const data = (result?.data || [])
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.id,
        model: model.model,
        displayName: model.displayName,
        description: model.description,
        isDefault: model.isDefault,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts || [],
        inputModalities: model.inputModalities || [],
      }));
    sendJson(response, 200, { data });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const client = {
      deviceId: authentication?.session?.id || null,
      connectedAt: Date.now(),
      queue: [],
      queuedBytes: 0,
      backpressured: false,
      closed: false,
      onDrain: null,
    };
    client.onDrain = () => flushSseClient(response, client);
    sseClients.set(response, client);
    queueSseFrame(response, client, `data: ${JSON.stringify({ kind: "bridge/status", status: codex.status })}\n\n`);
    const heartbeat = setInterval(() => queueSseFrame(response, client, ": keepalive\n\n"), 20_000);
    heartbeat.unref?.();
    response.on("drain", client.onDrain);
    request.on("close", () => {
      clearInterval(heartbeat);
      closeSseClient(response);
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/threads") {
    const archived = url.searchParams.get("archived") === "true";
    const searchTerm = String(url.searchParams.get("search") || "").trim().slice(0, 160);
    const requestedLimit = Number.parseInt(url.searchParams.get("limit") || THREAD_LIST_PAGE_SIZE, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(MAX_THREAD_LIST_PAGE_SIZE, Math.max(1, requestedLimit))
      : THREAD_LIST_PAGE_SIZE;
    const cursor = String(url.searchParams.get("cursor") || "").slice(0, 2_048);
    const result = await codex.request("thread/list", {
      limit,
      sortKey: "recency_at",
      sortDirection: "desc",
      archived,
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      ...(searchTerm ? { searchTerm } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const data = (await Promise.all((result?.data || []).map(async (thread) => (
      await isAllowedThreadPath(thread.cwd) ? serializeThreadWithOrigin(thread) : null
    )))).filter(Boolean);
    sendJson(response, 200, { ...result, data });
    return;
  }

  const threadTurnsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns$/);
  if (request.method === "GET" && threadTurnsMatch) {
    const threadId = decodeURIComponent(threadTurnsMatch[1]);
    const itemsView = url.searchParams.get("items") === "full" ? "full" : "summary";
    const complete = url.searchParams.get("complete") === "true";
    const sortDirection = url.searchParams.get("sort") === "asc" ? "asc" : "desc";
    const page = await readThreadTurnsPage(threadId, {
      cursor: url.searchParams.get("cursor"),
      limit: url.searchParams.get("limit"),
      itemsView,
      complete,
      sortDirection,
    });
    sendJson(response, 200, page);
    return;
  }

  const threadArtifactsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/artifacts$/);
  if (request.method === "GET" && threadArtifactsMatch) {
    const threadId = decodeURIComponent(threadArtifactsMatch[1]);
    const thread = await allowedThread(threadId, false);
    const artifacts = await listThreadArtifacts(threadId, thread);
    sendJson(response, 200, { data: artifacts });
    return;
  }

  const threadArtifactRawMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/artifacts\/([^/]+)\/raw$/);
  if ((request.method === "GET" || request.method === "HEAD") && threadArtifactRawMatch) {
    const threadId = decodeURIComponent(threadArtifactRawMatch[1]);
    const artifactId = decodeURIComponent(threadArtifactRawMatch[2]);
    await sendThreadArtifact(request, response, threadId, artifactId, url);
    return;
  }

  const historyOutputMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/outputs\/([^/]+)$/);
  if (request.method === "GET" && historyOutputMatch) {
    const threadId = decodeURIComponent(historyOutputMatch[1]);
    const itemId = decodeURIComponent(historyOutputMatch[2]);
    await allowedThread(threadId, false);
    const key = `${threadId}:${itemId}`;
    const cached = historyOutputCache.get(key);
    if (!cached) {
      const error = new Error("完整输出缓存已过期，请重新加载最近活动详情");
      error.statusCode = 404;
      throw error;
    }
    historyOutputCache.delete(key);
    historyOutputCache.set(key, cached);
    sendJson(response, 200, { output: cached.output });
    return;
  }

  const threadTranscriptMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/transcript$/);
  if (request.method === "GET" && threadTranscriptMatch) {
    const threadId = decodeURIComponent(threadTranscriptMatch[1]);
    await allowedThread(threadId, false);
    const turnId = String(url.searchParams.get("turnId") || activeTurns.get(threadId) || "").slice(0, 160);
    if (!turnId) throw new Error("No active turn was found");
    const turn = await readActiveNarrative(threadId, turnId);
    if (!turn) {
      const error = new Error("The requested turn transcript is no longer available");
      error.statusCode = 404;
      throw error;
    }
    sendJson(response, 200, { turn });
    return;
  }

  const threadGoalMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/goal$/);
  if (threadGoalMatch && request.method === "GET") {
    const threadId = decodeURIComponent(threadGoalMatch[1]);
    await allowedThread(threadId, false);
    const result = await requestThreadGoal(threadId);
    sendJson(response, 200, result);
    return;
  }

  if (threadGoalMatch && request.method === "POST") {
    const threadId = decodeURIComponent(threadGoalMatch[1]);
    await allowedThread(threadId, false);
    const result = await requestThreadGoal(threadId);
    if (!result.supported) throw goalUnsupportedError();
    const body = await readBody(request);
    const params = goalSetParams(threadId, body);
    try {
      const updated = await codex.request("thread/goal/set", params);
      sendJson(response, 200, { supported: true, goal: updated?.goal || null });
    } catch (error) {
      if (isUnsupportedRpcError(error)) throw goalUnsupportedError();
      throw error;
    }
    return;
  }

  if (threadGoalMatch && request.method === "DELETE") {
    const threadId = decodeURIComponent(threadGoalMatch[1]);
    await allowedThread(threadId, false);
    const result = await requestThreadGoal(threadId);
    if (!result.supported) throw goalUnsupportedError();
    try {
      await codex.request("thread/goal/clear", { threadId });
      sendJson(response, 200, { supported: true, goal: null });
    } catch (error) {
      if (isUnsupportedRpcError(error)) throw goalUnsupportedError();
      throw error;
    }
    return;
  }

  const threadReadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (request.method === "GET" && threadReadMatch) {
    const threadId = decodeURIComponent(threadReadMatch[1]);
    let thread = await allowedThread(threadId, false);
    let liveSubscribed = false;
    let subscriptionError = null;
    // `thread/read` carries the persisted model/effort even for archived
    // tasks. Use it as a read-only fallback when live subscription is not
    // requested or temporarily unavailable; a successful resume still
    // replaces it with the authoritative permission-aware settings.
    let settings = serializeThreadSettings(thread);
    if (usesSharedDaemon && url.searchParams.get("subscribe") === "true") {
      try {
        const subscribed = await subscribeThread(threadId, thread);
        thread = subscribed.thread;
        settings = subscribed.settings || settings;
        liveSubscribed = true;
      } catch (error) {
        subscriptionError = error.message;
        console.warn(`[app-server] Unable to subscribe to thread ${threadId}: ${error.message}`);
      }
    }
    const [history, goalState] = await Promise.all([
      readThreadTurnsPage(threadId, { validate: false }),
      requestThreadGoalBestEffort(threadId),
    ]);
    const activeTurnId = liveSubscribed
      ? syncActiveTurnFromHistory(threadId, history, thread.status)
      : activeTurns.get(threadId) || null;
    const hasLiveActivity = Boolean(activeTurnId)
      || thread.status?.type === "active"
      || hasPendingThreadRequest(threadId);
    if (liveSubscribed && !hasLiveActivity) {
      scheduleThreadRelease(threadId, IDLE_SUBSCRIPTION_LEASE_MS, "idle-subscription-lease");
    }
    sendJson(response, 200, {
      thread: await serializeThreadWithOrigin(thread),
      history,
      goal: goalState.goal,
      goalSupported: goalState.supported,
      activeTranscriptAvailable: Boolean(activeTurnId && hasLiveActivity),
      settings,
      activeTurnId,
      liveSubscribed,
      subscriptionError,
      ownership: releasingThreads.has(threadId) ? "releasing" : ownedThreads.has(threadId) ? "owned" : "released",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/threads") {
    const body = await readBody(request);
    const cwd = await resolveAllowedDirectory(body.cwd || roots[0]);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) throw new Error("Prompt is required");
    const model = String(body.model || "").trim().slice(0, 120);
    const effort = String(body.effort || "").trim().slice(0, 32);
    const permission = threadStartPermission(String(body.permissionPreset || "request"));
    const started = await codex.request("thread/start", {
      cwd,
      ...permission,
      serviceName: "codex-pwa",
      threadSource: "codex-pwa-mobile",
      ...(model ? { model } : {}),
    });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("Codex did not return a thread id");
    if (usesSharedDaemon) {
      codex.subscribedThreads.add(threadId);
      codex.subscriptionSettings.set(threadId, serializeThreadSettings(started || {}));
    }
    markThreadOwned(threadId);
    let goalError = null;
    if (body.goal && typeof body.goal === "object" && !Array.isArray(body.goal)) {
      try {
        await codex.request("thread/goal/set", goalSetParams(threadId, body.goal));
      } catch (error) {
        goalError = error.message;
        console.warn(`[app-server] Unable to set initial Goal for ${threadId}: ${error.message}`);
        broadcast({ kind: "bridge/log", level: "warning", message: `任务已创建，但 Goal 暂未写入：${error.message}` });
      }
    }
    const name = initialThreadName(prompt);
    let thread = started.thread;
    try {
      await codex.request("thread/name/set", { threadId, name });
      thread = { ...thread, name };
    } catch (error) {
      console.warn(`[app-server] Unable to set initial thread name: ${error.message}`);
      broadcast({
        kind: "bridge/log",
        level: "warning",
        message: "新任务已创建，但自动命名暂未写入任务索引。",
      });
    }
    let turn;
    try {
      turn = await codex.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        ...(effort ? { effort } : {}),
      });
    } catch (error) {
      scheduleThreadRelease(threadId, 0, "turn-start-failed");
      throw error;
    }
    const effectiveSettings = mergeThreadSettings(
      serializeThreadSettings(started),
      effort ? { effort } : {},
    );
    if (usesSharedDaemon) codex.subscriptionSettings.set(threadId, effectiveSettings);
    const goalState = await requestThreadGoalBestEffort(threadId);
    sendJson(response, 201, {
      thread: await serializeThreadWithOrigin(thread),
      turn: turn.turn,
      settings: effectiveSettings,
      goal: goalState.goal,
      goalSupported: goalState.supported,
      goalError,
    });
    return;
  }

  if (request.method === "POST" && threadTurnsMatch) {
    const threadId = decodeURIComponent(threadTurnsMatch[1]);
    const allowed = await allowedThread(threadId, false);
    const body = await readBody(request);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) throw new Error("Prompt is required");
    clearThreadReleaseTimer(threadId);
    const resumed = await subscribeThread(threadId, allowed);
    const currentSettings = resumed.settings || serializeThreadSettings(resumed.thread || {});
    const overrides = parseSettingsOverrides(body.settings, currentSettings);
    markThreadOwned(threadId);
    let result;
    try {
      result = await codex.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        ...overrides.rpc,
      });
    } catch (error) {
      scheduleThreadRelease(threadId, 0, "turn-start-failed");
      throw error;
    }
    const effectiveSettings = mergeThreadSettings(currentSettings, overrides.applied);
    if (usesSharedDaemon) codex.subscriptionSettings.set(threadId, effectiveSettings);
    sendJson(response, 202, {
      ...result,
      settings: effectiveSettings,
    });
    return;
  }

  const releaseMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/release$/);
  if (request.method === "POST" && releaseMatch) {
    const threadId = decodeURIComponent(releaseMatch[1]);
    await allowedThread(threadId, false);
    const result = await releaseThread(threadId, { reason: "manual-unsubscribe" });
    sendJson(response, 200, { ...result, threadId });
    return;
  }

  const pinMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/pin$/);
  if (request.method === "POST" && pinMatch) {
    const threadId = decodeURIComponent(pinMatch[1]);
    await allowedThread(threadId, false);
    const body = await readBody(request);
    if (typeof body.isPinned !== "boolean") throw new Error("isPinned must be a boolean");
    const result = await codex.request("thread/metadata/update", {
      threadId,
      isPinned: body.isPinned,
    });
    sendJson(response, 200, {
      thread: await serializeThreadWithOrigin(result?.thread || { id: threadId, isPinned: body.isPinned }),
    });
    return;
  }

  const steerMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/steer$/);
  if (request.method === "POST" && steerMatch) {
    const threadId = decodeURIComponent(steerMatch[1]);
    await allowedThread(threadId, false);
    const body = await readBody(request);
    const prompt = String(body.prompt || "").trim();
    const turnId = String(body.turnId || activeTurns.get(threadId) || "");
    if (!prompt || !turnId) throw new Error("Prompt and active turn id are required");
    const result = await codex.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: prompt }],
    });
    sendJson(response, 202, result);
    return;
  }

  const interruptMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/interrupt$/);
  if (request.method === "POST" && interruptMatch) {
    const threadId = decodeURIComponent(interruptMatch[1]);
    await allowedThread(threadId, false);
    const body = await readBody(request);
    const turnId = String(body.turnId || activeTurns.get(threadId) || "");
    if (!turnId) throw new Error("No active turn was found");
    const result = await codex.request("turn/interrupt", { threadId, turnId });
    sendJson(response, 200, result);
    return;
  }

  const renameMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/name$/);
  if (request.method === "POST" && renameMatch) {
    const threadId = decodeURIComponent(renameMatch[1]);
    await allowedThread(threadId, false);
    const body = await readBody(request);
    const name = String(body.name || "").trim().slice(0, 160);
    if (!name) throw new Error("Thread name is required");
    await codex.request("thread/name/set", { threadId, name });
    sendJson(response, 200, { ok: true, name });
    return;
  }

  const archiveMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/archive$/);
  if (request.method === "POST" && archiveMatch) {
    const threadId = decodeURIComponent(archiveMatch[1]);
    await allowedThread(threadId, false);
    await codex.request("thread/archive", { threadId });
    sendJson(response, 200, { ok: true });
    return;
  }

  const unarchiveMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/unarchive$/);
  if (request.method === "POST" && unarchiveMatch) {
    const threadId = decodeURIComponent(unarchiveMatch[1]);
    const result = await codex.request("thread/unarchive", { threadId });
    if (!result?.thread || !isAllowedPath(result.thread.cwd)) {
      const error = new Error("Thread is outside the allowed roots");
      error.statusCode = 403;
      throw error;
    }
    sendJson(response, 200, { thread: await serializeThreadWithOrigin(result.thread) });
    return;
  }

  const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (request.method === "POST" && approvalMatch) {
    const requestId = decodeURIComponent(approvalMatch[1]);
    const pending = codex.serverRequests.get(requestId);
    if (!pending) throw new Error("Approval request no longer exists");
    if (pending.params?.threadId) await allowedThread(pending.params.threadId, false);
    const body = await readBody(request);
    const decision = String(body.decision || "");
    const allowedDecisions = new Set(["accept", "acceptForSession", "decline", "cancel"]);
    if (!allowedDecisions.has(decision)) throw new Error("Unsupported approval decision");

    if (pending.method === "item/commandExecution/requestApproval" || pending.method === "item/fileChange/requestApproval") {
      codex.respondToServerRequest(requestId, { decision });
    } else if (pending.method === "execCommandApproval" || pending.method === "applyPatchApproval") {
      const legacyDecision = {
        accept: "approved",
        acceptForSession: "approved_for_session",
        decline: { denied: { rejection: "Declined from Codex PWA" } },
        cancel: "abort",
      }[decision];
      codex.respondToServerRequest(requestId, { decision: legacyDecision });
    } else {
      throw new Error(`Unsupported approval method: ${pending.method}`);
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  const requestResponseMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/respond$/);
  if (request.method === "POST" && requestResponseMatch) {
    const requestId = decodeURIComponent(requestResponseMatch[1]);
    const pending = codex.serverRequests.get(requestId);
    if (!pending) throw new Error("Interactive request no longer exists");
    if (pending.params?.threadId) await allowedThread(pending.params.threadId, false);
    if (pending.method !== "item/tool/requestUserInput" && pending.method !== "tool/requestUserInput") {
      throw new Error("Unsupported interactive response type");
    }
    const body = await readBody(request);
    const answers = body.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw new Error("Answers are required");
    }
    codex.respondToServerRequest(requestId, { answers });
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "API endpoint not found" });
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveStaticFile(requestedPath) {
  const mount = vendorMounts.find(({ prefix }) => requestedPath.startsWith(prefix));
  const directory = mount?.directory || publicDir;
  const relativePath = mount ? requestedPath.slice(mount.prefix.length) : requestedPath.slice(1);
  const filePath = resolve(directory, normalize(relativePath));
  if (filePath === directory || !filePath.startsWith(`${directory}${sep}`)) return null;
  return filePath;
}

async function serveStatic(request, response, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = resolveStaticFile(requestedPath);
  if (!filePath) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  try {
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error("Not a file");
    const extension = extname(filePath);
    const isCoreShell = !requestedPath.startsWith("/vendor/") && (
      requestedPath === "/"
      || new Set([".html", ".js", ".css", ".webmanifest"]).has(extension)
    );
    const cacheControl = requestedPath === "/sw.js" || isCoreShell
      ? "no-cache"
      : requestedPath.startsWith("/vendor/")
        ? "public, max-age=3600, must-revalidate"
        : "public, max-age=86400";
    response.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
      "content-length": details.size,
      "cache-control": cacheControl,
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

const server = createServer(async (request, response) => {
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
      await handleApi(request, response, url, authentication);
    } else {
      await serveStatic(request, response, url);
    }
  } catch (error) {
    sendError(response, error, error.statusCode || 400);
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
  codex.stop();
  for (const response of [...sseClients.keys()]) closeSseClient(response);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
