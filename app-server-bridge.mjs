import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import readline from "node:readline";
import WebSocket from "ws";
import { normalizeProtocolMessage, normalizeProtocolSnapshot, interactiveRequestThreadId, isSupportedInteractiveRequest } from "./protocol-adapter.mjs";
import { approvalRequestChangedError } from "./error-utils.mjs";
import { FileApprovalContexts, fileApprovalKey } from "./file-approval-context.mjs";

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

export function createCodexAppServer({
  codexBin,
  roots,
  usesSharedDaemon,
  daemonSocket,
  appVersion,
  maxWebSocketPayloadBytes,
  sharedDaemonHeartbeatMs,
  sharedDaemonReconnectMaxDelayMs,
  rpcMutationMethods,
  rpcReadTimeoutMs,
  rpcMutationTimeoutMs,
  retryableRpcMethods,
  rpcOverloadRetryLimit,
  autoReleaseDelayMs,
  broadcast,
  resetThreadOwnership,
  activeTurns,
  markThreadOwned,
  scheduleThreadRelease,
  forgetThreadOwnership,
  sanitizeNotificationForBrowser,
}) {
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
      this.fileApprovalContexts = new FileApprovalContexts();
      this.nextId = 1;
      this.readyPromise = null;
      this.status = "stopped";
      this.lastError = null;
      this.intentionalStop = false;
      this.recyclePromise = null;
      this.protocol = normalizeProtocolSnapshot(null);
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

      const initializeResult = await this.requestRaw("initialize", {
        clientInfo: {
          name: "codex_pwa",
          title: "Codex PWA",
          version: appVersion,
        },
        capabilities: { experimentalApi: true },
      });
      this.protocol = normalizeProtocolSnapshot(initializeResult);
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
        maxPayload: maxWebSocketPayloadBytes,
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

      socket._socket?.setKeepAlive?.(true, sharedDaemonHeartbeatMs);
      this.startSharedHeartbeat(socket);

      socket.on("message", (payload, isBinary) => {
        if (this.socket !== socket) return;
        this.socketPongAt = Date.now();
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
        if (Date.now() - this.socketPongAt > sharedDaemonHeartbeatMs * 2.5) {
          console.warn("[app-server] Shared Codex daemon heartbeat timed out; reconnecting");
          socket.terminate();
          return;
        }
        try {
          socket.ping();
        } catch (error) {
          this.onExit(error, socket);
        }
      }, sharedDaemonHeartbeatMs);
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
        sharedDaemonReconnectMaxDelayMs,
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
      this.fileApprovalContexts.clear();
      resetThreadOwnership("released");
      this.warnSharedError(error.message);
      broadcast({ kind: "bridge/status", status: this.status, error: error.message });
      this.scheduleSharedReconnect();
    }

    publishServerRequest(requestId, pending) {
      this.serverRequests.set(requestId, pending);
      broadcast({ kind: "app-server/request", requestId, requestToken: pending.requestToken,
        method: pending.method, params: pending.params,
        ...(pending.fileChangeContext ? { fileChangeContext: pending.fileChangeContext } : {}),
      });
    }

    onLine(line) {
      let message;
      try {
        message = normalizeProtocolMessage(JSON.parse(line));
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
        if (!isSupportedInteractiveRequest(message.method)) {
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
        if (!interactiveRequestThreadId(message)) {
          this.sendRpcMessage({ id: message.id, error: {
            code: -32602, message: "Interactive request is missing a valid task identity",
          } });
          broadcast({ kind: "bridge/log", level: "warning", message: "审批或问答请求缺少有效任务标识，已拒绝处理" });
          return;
        }
        const requestId = String(message.id);
        const requestToken = randomUUID();
        this.publishServerRequest(requestId, {
          id: message.id,
          requestToken,
          method: message.method,
          params: message.params || {},
          receivedAt: Date.now(),
          ...(message.method === "item/fileChange/requestApproval"
            ? { fileChangeContext: this.fileApprovalContexts.get(message.params) } : {}),
        });
        return;
      }

      const changedFileKey = this.fileApprovalContexts.observe(message);
      if (changedFileKey) {
        for (const [requestId, pending] of this.serverRequests) {
          if (pending.method !== "item/fileChange/requestApproval" || fileApprovalKey(pending.params) !== changedFileKey) continue;
          const context = this.fileApprovalContexts.get(pending.params);
          if (JSON.stringify(context) === JSON.stringify(pending.fileChangeContext)) continue;
          // A late or revised patch invalidates confirmations and queued writes.
          this.publishServerRequest(requestId, { ...pending, requestToken: randomUUID(), fileChangeContext: context });
        }
      }

      if (message.method === "serverRequest/resolved") {
        const requestId = String(message.params?.requestId ?? message.params?.id ?? "");
        const pending = this.serverRequests.get(requestId);
        if (pending && (!pending.params?.threadId || pending.params.threadId === message.params?.threadId)) {
          this.serverRequests.delete(requestId);
        }
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
        const turnId = message.params?.turn?.id;
        if (threadId && (!activeTurns.has(threadId) || activeTurns.get(threadId) === turnId)) {
          activeTurns.delete(threadId);
          scheduleThreadRelease(threadId, autoReleaseDelayMs, "turn-completed");
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
      broadcast({ kind: "app-server/notification", message: {
        ...sanitizeNotificationForBrowser(message), pwaReceivedAt: Date.now() / 1000,
      } });
    }

    requestRaw(method, params = {}) {
      if (!this.isWritable()) {
        return Promise.reject(new Error("Codex app-server is not writable"));
      }
      const id = this.nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        const mutating = rpcMutationMethods.has(method);
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
        }, mutating ? rpcMutationTimeoutMs : rpcReadTimeoutMs);
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
          if (!overloaded || !retryableRpcMethods.has(method) || attempt >= rpcOverloadRetryLimit) {
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
        this.fileApprovalContexts.clear();
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

    respondToServerRequest(requestId, result, expected = null) {
      const pending = this.serverRequests.get(String(requestId));
      if (!pending || (expected && pending !== expected)) throw approvalRequestChangedError();
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
      this.fileApprovalContexts.clear();
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

  return new CodexAppServer();
}
