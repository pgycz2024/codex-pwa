import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

async function until(read, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${description}`);
}

async function fixture(t, { authenticated = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pwa-write-recovery-"));
  if (authenticated) await writeFile(join(root, "password"), "test-password-only", { mode: 0o600 });
  const daemon = createServer();
  const websocket = new WebSocketServer({ server: daemon });
  const writes = [];
  const received = [];
  const rpcErrors = [];
  let connections = 0;
  let connection;
  let child;
  let diagnostics = "";
  t.after(async () => {
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    for (const socket of websocket.clients) socket.terminate();
    websocket.close();
    await new Promise((resolve) => daemon.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  websocket.on("connection", (socket) => {
    connections += 1;
    connection = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      received.push(message);
      const reply = (result) => socket.send(JSON.stringify({ id: message.id, result }));
      if (Object.hasOwn(message, "error")) rpcErrors.push(message);
      else if (message.method === "initialize") reply({ userAgent: "write-test/0.153.2" });
      else if (message.method === "thread/start") reply({ thread: { id: "created-task", cwd: root } });
      else if (message.method === "thread/name/set") reply({});
      else if (["thread/read", "thread/resume"].includes(message.method)) {
        reply({ thread: { id: message.params.threadId, cwd: message.params.threadId === "outside-task" ? tmpdir() : root, status: { type: "idle" } } });
      } else if (message.method === "thread/unsubscribe") reply({});
      else if (message.method === "thread/goal/get") reply({ goal: null });
      else if (message.method === "thread/turns/list") reply({ data: [], nextCursor: null });
      else if (message.method?.startsWith("turn/") || Object.hasOwn(message, "result")) {
        writes.push({ ...message, reply, fail: () => socket.send(JSON.stringify({
          id: message.id,
          error: {
            code: -32000,
            message: "active writer belongs to another client",
            details: { activeWriter: { client: "codex-windows", device: "工作电脑", source: "vscode" } },
          },
        })) });
      }
    });
  });
  const socketPath = join(root, "daemon.sock");
  await new Promise((resolve) => daemon.listen(socketPath, resolve));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  child = spawn(process.execPath, ["--unhandled-rejections=strict", "server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env, NODE_ENV: "test",
      CODEX_PWA_HOST: "127.0.0.1", CODEX_PWA_PORT: String(port),
      CODEX_PWA_ROOTS: root, CODEX_PWA_PASSWORD_FILE: authenticated ? join(root, "password") : "",
      CODEX_PWA_SESSION_FILE: join(root, "devices.json"),
      CODEX_PWA_APP_SERVER_MODE: "shared-daemon", CODEX_PWA_DAEMON_SOCKET: socketPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.on("data", (data) => { diagnostics = (diagnostics + data).slice(-4000); });
  const base = `http://127.0.0.1:${port}`;
  const health = () => fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
  await until(async () => {
    assert.equal(child.exitCode, null, diagnostics);
    try { return (await health()).ok; } catch { return false; }
  }, "test bridge ready");
  const status = async () => (await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1000) })).json();
  const post = async (path, body, signal) => {
    const approvalId = path.match(/^\/api\/(?:approvals\/([^/]+)|requests\/([^/]+)\/respond)$/);
    if (approvalId && !Object.hasOwn(body, "requestToken")) {
      const pending = (await status()).pendingApprovals.find((entry) => entry.requestId === (approvalId[1] || approvalId[2]));
      body = { ...body, requestToken: pending?.requestToken };
    }
    return fetch(`${base}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    });
  };
  const login = async (deviceLabel) => {
    const response = await post("/api/auth/login", { username: "codex", password: "test-password-only", deviceLabel });
    assert.equal(response.status, 200);
    const session = await response.json();
    const cookie = response.headers.get("set-cookie").split(";")[0];
    return (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: {
      "content-type": "application/json", cookie, "X-Codex-PWA-CSRF": session.csrfToken, ...options.headers,
    } });
  };
  return { child, root, base, writes, received, rpcErrors, health, status, post, login,
    get connections() { return connections; }, disconnect: () => connection.terminate(),
    notify: (message) => connection.send(JSON.stringify(message)) };
}

test("message correlation survives HTTP task creation, send and steering without becoming a device id", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.status()).protocol.bridgeCapabilities.clientMessageCorrelation, true);
  for (const [index, path] of ["/api/threads", "/api/threads/task/turns", "/api/threads/task/steer"].entries()) {
    const clientUserMessageId = `pwa-message-correlation-${index}`;
    const response = f.post(path, { cwd: f.root, prompt: "继续", turnId: "running-turn", clientUserMessageId });
    await until(() => f.writes.length === index + 1, "correlated input reaches Codex");
    assert.equal(f.writes[index].params.clientUserMessageId, clientUserMessageId);
    assert.equal(f.writes[index].params.input[0].text, "继续");
    assert.equal(Object.hasOwn(f.writes[index].params, "deviceId"), false);
    f.writes[index].reply({ turn: { id: "running-turn", status: "inProgress" } });
    assert.equal((await response).status, index === 0 ? 201 : 202);
  }
});

test("invalid message ids are rejected before creating a task or dispatching input", async (t) => {
  const f = await fixture(t);
  for (const path of ["/api/threads", "/api/threads/task/turns", "/api/threads/task/steer"]) {
    for (const clientUserMessageId of ["", "short", "a".repeat(81), "has space in identity", 123, {}]) {
      const response = await f.post(path, { cwd: f.root, prompt: "继续", turnId: "running-turn", clientUserMessageId });
      assert.equal(response.status, 400);
      assert.deepEqual((await response.json()).details, { code: "INVALID_CLIENT_MESSAGE_ID", dispatched: false, outcomeUnknown: false });
    }
  }
  assert.equal(f.writes.length, 0);
  assert.equal(f.received.some((entry) => ["thread/start", "thread/resume"].includes(entry.method)), false);
});

test("v2 file approvals associate only the exact task, turn and item and expose a bounded summary", async (t) => {
  const f = await fixture(t);
  const item = (threadId, turnId, path) => ({ method: "item/started", params: { threadId, turnId,
    item: { id: "patch", type: "fileChange", status: "inProgress", changes: [{ path, kind: { type: "delete" }, diff: "private diff" }] } } });
  f.notify(item("other-task", "turn", "/srv/other.txt"));
  f.notify(item("task", "old-turn", "/srv/old.txt"));
  f.notify({ id: "file-approval", method: "item/fileChange/requestApproval", params: { threadId: "task", turnId: "turn", itemId: "patch", reason: "Confirm changes" } });
  const read = async () => (await f.status()).pendingApprovals.find((entry) => entry.requestId === "file-approval");
  await until(read, "file approval received");
  const before = await read();
  assert.equal(before.fileChangeContext?.status, "unavailable");
  f.notify(item("task", "turn", "/srv/right.txt"));
  const after = await until(async () => { const current = await read(); return current?.fileChangeContext?.status === "available" && current; }, "matching file context received");
  assert.deepEqual(after.fileChangeContext.changes, [{ path: "/srv/right.txt", kind: { type: "delete" } }]);
  assert.equal(after.fileChangeContext.destructive, true);
  assert.equal(after.fileChangeContext.totalFiles, 1);
  assert.notEqual(after.requestToken, before.requestToken, "newly visible evidence requires fresh confirmation");
  assert.equal(Object.hasOwn(after.params, "changes"), false, "PWA context must not invent upstream request fields");
  assert.doesNotMatch(JSON.stringify(after.fileChangeContext), /private diff/);
  assert.equal((await f.post("/api/approvals/file-approval", { decision: "accept", requestToken: before.requestToken })).status, 409);
  assert.equal(f.writes.length, 0);
  f.notify(item("task", "turn", "/srv/right.txt"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await read()).requestToken, after.requestToken, "repeated identical context keeps current confirmation valid");
  assert.equal((await f.post("/api/approvals/file-approval", { decision: "decline", requestToken: after.requestToken })).status, 200);
  await until(() => f.writes.length === 1, "decision received");
  assert.deepEqual(f.writes[0].result, { decision: "decline" });
});

test("queued file approval cannot confirm a patch changed after the user reviewed it", async (t) => {
  const f = await fixture(t);
  const notification = (diff) => ({ method: "item/started", params: { threadId: "task", turnId: "turn",
    item: { id: "patch", type: "fileChange", status: "inProgress", changes: [{ path: "/srv/file.txt", kind: { type: "update", move_path: null }, diff }] } } });
  f.notify(notification("-before\n+first"));
  f.notify({ id: "patch-queued", method: "item/fileChange/requestApproval", params: { threadId: "task", turnId: "turn", itemId: "patch" } });
  const read = async () => (await f.status()).pendingApprovals.find((entry) => entry.requestId === "patch-queued");
  const original = await until(read, "approval received");
  assert.equal(original.fileChangeContext?.status, "available");
  const running = f.post("/api/threads/task/turns", { prompt: "hold queue" });
  await until(() => f.writes.length === 1, "queue held");
  const queued = f.post("/api/approvals/patch-queued", { decision: "accept", requestToken: original.requestToken });
  await until(async () => (await f.status()).mutationQueues?.[0]?.pending === 1, "approval queued");
  f.notify({ method: "item/fileChange/patchUpdated", params: { threadId: "task", turnId: "turn", itemId: "patch",
    changes: notification("-before\n+second").params.item.changes } });
  const updated = await until(async () => { const next = await read(); return next?.requestToken !== original.requestToken && next; }, "patch changes invalidate approval");
  assert.deepEqual(updated.fileChangeContext.changes, original.fileChangeContext.changes);
  f.writes[0].reply({ turn: { id: "held", status: "inProgress" } });
  assert.equal((await running).status, 202);
  assert.equal((await queued).status, 409);
  assert.equal(f.writes.length, 1, "the stale acceptance must not reach the daemon");
});

test("bridge reconnect never reuses pre-disconnect file context for a replayed approval", async (t) => {
  const f = await fixture(t);
  const params = { threadId: "task", turnId: "turn", itemId: "patch" };
  const request = { id: "replayed-file", method: "item/fileChange/requestApproval", params };
  f.notify({ method: "item/fileChange/patchUpdated", params: { ...params,
    changes: [{ path: "/srv/project/previous.txt", kind: { type: "delete" }, diff: "old" }] } });
  f.notify(request);
  const read = async () => (await f.status()).pendingApprovals.find((entry) => entry.requestId === request.id);
  const original = await until(read, "original approval");
  assert.equal(original.fileChangeContext.status, "available");
  f.disconnect();
  await until(async () => f.connections === 2 && (await f.status()).bridge === "ready", "isolated daemon reconnected");
  f.notify(request);
  const replayed = await until(read, "replayed approval");
  assert.notEqual(replayed.requestToken, original.requestToken);
  assert.equal(replayed.fileChangeContext.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(replayed), /previous\.txt/);
});

test("command approval can submit only the decisions explicitly offered by Codex", async (t) => {
  const f = await fixture(t);
  f.notify({ id: "restricted-decisions", method: "item/commandExecution/requestApproval", params: {
    threadId: "task", turnId: "turn", itemId: "command", command: "pwd", availableDecisions: ["accept", "decline"],
  } });
  await until(async () => (await f.status()).pendingApprovals.length === 1, "restricted approval received");
  const unavailable = await f.post("/api/approvals/restricted-decisions", { decision: "acceptForSession" });
  assert.equal(unavailable.status, 400);
  assert.equal((await unavailable.json()).details.code, "APPROVAL_DECISION_UNAVAILABLE");
  assert.equal(f.writes.length, 0);
  assert.equal((await f.post("/api/approvals/restricted-decisions", { decision: "accept" })).status, 200);
  await until(() => f.writes.length === 1, "permitted approval received");
  assert.deepEqual(f.writes[0].result, { decision: "accept" });
});

test("interactive requests without their declared task identity are rejected before becoming actionable", async (t) => {
  const f = await fixture(t);
  const requests = [
    { id: "bad-legacy-command", method: "execCommandApproval", params: { threadId: "invented", command: ["pwd"] } },
    { id: "bad-legacy-patch", method: "applyPatchApproval", params: { conversationId: null, fileChanges: {} } },
    { id: "bad-current-command", method: "item/commandExecution/requestApproval", params: { command: "pwd" } },
    { id: "bad-current-patch", method: "item/fileChange/requestApproval", params: { threadId: 42 } },
    { id: "bad-question", method: "item/tool/requestUserInput", params: { threadId: " ", questions: [] } },
  ];
  for (const request of requests) f.notify(request);
  await until(() => f.rpcErrors.length === requests.length, "invalid request replies");
  assert.deepEqual(f.rpcErrors.map(({ id, error }) => [id, error.code]), requests.map(({ id }) => [id, -32602]));
  assert.deepEqual((await f.status()).pendingApprovals, []);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.health()).status, 200);
});

test("legacy approvals share task authorization and the write queue through conversationId", async (t) => {
  const f = await fixture(t);
  for (const method of ["execCommandApproval", "applyPatchApproval"]) {
    const requestId = `legacy-outside-${method}`;
    f.notify({ id: requestId, method, params: { conversationId: "outside-task", callId: "call", command: ["pwd"], fileChanges: {} } });
    await until(async () => (await f.status()).pendingApprovals.some((item) => item.requestId === requestId), "legacy request received");
    assert.equal((await f.post(`/api/approvals/${requestId}`, { decision: "accept" })).status, 403);
    assert.equal(f.writes.length, 0, "out-of-scope approvals must never reach the daemon");
    f.notify({ method: "serverRequest/resolved", params: { threadId: "outside-task", requestId } });
  }

  const running = f.post("/api/threads/task/turns", { prompt: "hold the task queue" });
  await until(() => f.writes.length === 1, "turn holds the write queue");
  const params = { conversationId: "task", callId: "legacy-command", command: ["pwd"], cwd: "/srv/project", reason: null, parsedCmd: [] };
  f.notify({ id: "legacy-queued", method: "execCommandApproval", params });
  await until(async () => (await f.status()).pendingApprovals.some((item) => item.requestId === "legacy-queued"), "legacy request received");
  const queued = f.post("/api/approvals/legacy-queued", { decision: "decline" });
  await until(async () => (await f.status()).mutationQueues?.[0]?.pending === 1, "legacy approval queues behind the turn");
  assert.equal(f.writes.length, 1);
  f.writes[0].reply({ turn: { id: "turn", status: "inProgress" } });
  assert.equal((await running).status, 202);
  assert.equal((await queued).status, 200);
  await until(() => f.writes.length === 2, "legacy decision reaches the daemon");
  assert.equal(f.writes[1].id, "legacy-queued");
  assert.deepEqual(f.writes[1].result, { decision: { denied: { rejection: "Declined from Codex PWA" } } });
});

test("authenticated clients can cancel only their own queued requests with CSRF validation", async (t) => {
  const f = await fixture(t, { authenticated: true });
  const desktop = await f.login("工作电脑");
  const phone = await f.login("我的手机");
  const first = desktop("/api/threads/task/turns", { method: "POST", body: JSON.stringify({ prompt: "active" }) });
  await until(() => f.writes.length === 1, "desktop dispatch");
  const id = "identified-phone-request";
  const path = `/api/threads/task/writes/${id}`;
  const waiting = phone("/api/threads/task/turns", { method: "POST",
    headers: { "X-Codex-PWA-Write-Id": id }, body: JSON.stringify({ prompt: "waiting" }),
  });
  await until(async () => {
    const response = await phone(path);
    return response.status === 200 && (await response.json()).state === "queued";
  }, "phone waiting");
  const snapshot = await (await phone(path)).json();
  assert.deepEqual(snapshot.waitingOn, { label: "工作电脑", currentDevice: false });
  assert.equal(snapshot.ownerId, undefined);
  assert.equal((await desktop(path)).status, 404);
  assert.equal((await desktop(path, { method: "DELETE" })).status, 404);
  assert.equal((await phone(path, { method: "DELETE", headers: { "X-Codex-PWA-CSRF": "invalid" } })).status, 403);
  const cancelled = await (await phone(path, { method: "DELETE" })).json();
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.details.dispatched, false);
  const reply = await waiting;
  assert.equal(reply.status, 499);
  assert.equal((await reply.json()).details.code, "THREAD_WRITE_CANCELLED");
  f.writes[0].reply({ turn: { id: "active", status: "inProgress" } });
  assert.equal((await first).status, 202);
  assert.equal(f.writes.length, 1);
  assert.equal((await phone(path)).status, 200, "cancelled receipt survives the original HTTP response");
});

test("HTTP cancellation reports dispatch races and exposes the completed response only to its device", async (t) => {
  const f = await fixture(t, { authenticated: true });
  const phone = await f.login("手机");
  const other = await f.login("其他设备");
  const id = "identified-running-request";
  const path = `/api/threads/task/writes/${id}`;
  const request = phone("/api/threads/task/turns", { method: "POST",
    headers: { "X-Codex-PWA-Write-Id": id }, body: JSON.stringify({ prompt: "running" }),
  });
  await until(() => f.writes.length === 1, "dispatch");
  assert.equal((await (await phone(path, { method: "DELETE" })).json()).state, "running");
  f.writes[0].reply({ turn: { id: "accepted", status: "inProgress" } });
  const reply = await (await request).json();
  const receipt = await (await phone(path)).json();
  assert.equal(receipt.state, "succeeded");
  assert.deepEqual(receipt.result, reply);
  assert.equal((await other(path)).status, 404);
  assert.equal((await phone(path + "-unknown", { method: "DELETE" })).status, 404);
});

test("HTTP write conflicts preserve the Web UI process and allow a following write", async (t) => {
  const f = await fixture(t);
  const failed = f.post("/api/threads/task/turns", { prompt: "first" });
  await until(() => f.writes.length === 1, "first write arrives");
  const following = f.post("/api/threads/task/turns", { prompt: "following" });
  await until(async () => (await f.status()).mutationQueues?.[0]?.pending === 1, "following write queued");
  f.writes[0].fail();
  const response = await failed;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).details.code, "THREAD_WRITE_CONFLICT");
  await until(() => f.writes.length === 2, "next write after conflict");
  f.writes[1].reply({ turn: { id: "next", status: "inProgress" } });
  assert.equal((await following).status, 202);
  const refreshedResponse = await fetch(`${f.base}/api/threads/task`);
  assert.equal(refreshedResponse.status, 200);
  const refreshed = await refreshedResponse.json();
  assert.equal(refreshed.thread.writerEvidence.kind, "active-writer-conflict");
  assert.equal(refreshed.thread.writerEvidence.source, "app-server");
  assert.equal(refreshed.thread.writerEvidence.reportedWriter.label, "工作电脑");
  assert.equal(refreshed.thread.writerEvidence.reportedWriter.client, "codex-windows");
  assert.equal(refreshed.thread.writerEvidence.reportedWriter.source, "vscode");
  assert.ok(Number.isFinite(refreshed.thread.writerEvidence.observedAt));
  assert.equal((await f.health()).status, 200);
  assert.equal(f.child.exitCode, null);
});

test("HTTP disconnect removes queued sends, steering, stops, approvals and answers", async (t) => {
  const f = await fixture(t);
  const first = f.post("/api/threads/task/turns", { prompt: "active" });
  await until(() => f.writes.length === 1, "first write arrives");
  f.notify({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "task" } });
  f.notify({ id: "answer", method: "item/tool/requestUserInput", params: { threadId: "task", questions: [] } });
  await until(async () => (await f.status()).pendingApprovals.length === 2, "approval and question received");
  const requests = [
    ["/api/threads/task/turns", { prompt: "cancelled" }],
    ["/api/threads/task/steer", { prompt: "cancelled", turnId: "active" }],
    ["/api/threads/task/interrupt", { turnId: "active" }],
    ["/api/approvals/approval", { decision: "accept" }],
    ["/api/requests/answer/respond", { answers: {} }],
  ];
  for (const [path, body] of requests) {
    const abort = new AbortController();
    const waiting = f.post(path, body, abort.signal);
    const cancelled = assert.rejects(waiting, (error) => error.name === "AbortError");
    await until(async () => (await f.status()).mutationQueues?.[0]?.pending === 1, `${path} queued`);
    abort.abort();
    await cancelled;
    await until(async () => (await f.status()).mutationQueues?.[0]?.pending === 0, `${path} removed after disconnect`);
  }
  f.writes[0].reply({ turn: { id: "first", status: "inProgress" } });
  assert.equal((await first).status, 202);
  await until(async () => (await f.status()).mutationQueues.length === 0, "queue drained");
  assert.equal(f.writes.length, 1, "cancelled requests must not reach the daemon");
  assert.equal((await f.status()).pendingApprovals.length, 2, "cancelled approvals remain answerable");
  assert.equal((await f.health()).status, 200);
});

test("an HTTP disconnect after dispatch holds the queue until Codex acknowledges", async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  const first = f.post("/api/threads/task/turns", { prompt: "already sent" }, abort.signal);
  const disconnected = assert.rejects(first, (error) => error.name === "AbortError");
  await until(() => f.writes.length === 1, "first write arrives");
  abort.abort();
  await disconnected;
  const following = f.post("/api/threads/task/turns", { prompt: "following" });
  await until(async () => (await f.status()).mutationQueues?.[0]?.pending === 1, "next write waits for acknowledgement");
  assert.equal(f.writes.length, 1);
  f.writes[0].reply({ turn: { id: "first", status: "inProgress" } });
  await until(() => f.writes.length === 2, "following write dispatched");
  f.writes[1].reply({ turn: { id: "second", status: "inProgress" } });
  assert.equal((await following).status, 202);
  assert.equal((await f.health()).status, 200);
});

test("external resolutions remove pending requests and prevent queued answers reaching the daemon", async (t) => {
  const f = await fixture(t);
  f.notify({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "task" } });
  f.notify({ id: 0, method: "item/tool/requestUserInput", params: { threadId: "task", questions: [] } });
  await until(async () => (await f.status()).pendingApprovals.length === 2, "pending server requests");
  // A malformed resolution for a different task must not clear this task's request.
  f.notify({ method: "serverRequest/resolved", params: { threadId: "other", requestId: "approval" } });
  assert.equal((await f.status()).pendingApprovals.length, 2);
  const first = f.post("/api/threads/task/turns", { prompt: "hold queue" });
  await until(() => f.writes.length === 1, "active request holds queue");
  const answer = f.post("/api/requests/0/respond", { answers: { question: { answers: ["yes"] } } });
  const approval = f.post("/api/approvals/approval", { decision: "accept" });
  await until(async () => (await f.status()).mutationQueues?.[0]?.pending === 2, "answers queued");
  f.notify({ method: "serverRequest/resolved", params: { threadId: "task", requestId: 0 } });
  f.notify({ method: "serverRequestResolved", params: { threadId: "task", requestId: "approval" } });
  await until(async () => (await f.status()).pendingApprovals.length === 0, "resolved requests removed from reconnect snapshot");
  f.writes[0].reply({ turn: { id: "accepted", status: "inProgress" } });
  assert.equal((await first).status, 202);
  assert.equal((await answer).ok, false);
  assert.equal((await approval).ok, false);
  assert.equal(f.writes.length, 1, "no stale decision may be sent after resolution");
  assert.equal((await f.health()).status, 200);
});

test("queued approvals cannot answer a replacement that reuses the original RPC id", async (t) => {
  const f = await fixture(t);
  f.notify({ id: "reused", method: "item/commandExecution/requestApproval", params: { threadId: "task", command: "pwd" } });
  await until(async () => (await f.status()).pendingApprovals.length === 1, "first request observed");
  const first = f.post("/api/threads/task/turns", { prompt: "hold queue" });
  await until(() => f.writes.length === 1, "queue held");
  const approval = f.post("/api/approvals/reused", { decision: "accept" });
  await until(async () => (await f.status()).mutationQueues?.[0]?.pending === 1, "approval queued");
  f.notify({ id: "reused", method: "item/commandExecution/requestApproval", params: { threadId: "task", command: "replacement command" } });
  await until(async () => (await f.status()).pendingApprovals[0]?.params?.command === "replacement command", "replacement received");
  f.writes[0].reply({ turn: { id: "accepted", status: "inProgress" } });
  await first;
  assert.equal((await approval).ok, false, "stale approval must not answer the replacement");
  assert.equal(f.writes.length, 1);
  assert.equal((await f.status()).pendingApprovals.length, 1);
});

test("approval and answer endpoints require the exact current request identity", async (t) => {
  const f = await fixture(t);
  for (const [method, path, body] of [
    ["item/commandExecution/requestApproval", "/api/approvals/0", { decision: "accept" }],
    ["item/tool/requestUserInput", "/api/requests/0/respond", { answers: { q: { answers: ["yes"] } } }],
  ]) {
    f.notify({ id: 0, method, params: { threadId: "task" } });
    const previous = await until(async () => (await f.status()).pendingApprovals.find((item) => item.requestId === "0"), "request identity");
    assert.match(previous.requestToken, /^[\da-f-]{36}$/);
    f.notify({ id: 0, method, params: { threadId: "task" } });
    const latest = await until(async () => {
      const item = (await f.status()).pendingApprovals.find((item) => item.requestId === "0");
      return item?.requestToken !== previous.requestToken ? item : null;
    }, "new identity even for identical request fields");
    const before = f.writes.length;
    for (const requestToken of [undefined, previous.requestToken]) {
      const response = await f.post(path, { ...body, requestToken });
      assert.equal(response.status, 409);
      const error = await response.json();
      assert.equal(error.details.code, "APPROVAL_REQUEST_CHANGED");
      assert.equal(error.details.dispatched, false);
    }
    assert.equal(f.writes.length, before);
    const accepted = await f.post(path, { ...body, requestToken: latest.requestToken });
    assert.equal(accepted.status, 200);
    await until(() => f.writes.length === before + 1, "correct response reaches daemon");
    assert.deepEqual(f.writes.at(-1).result, body);
    assert.equal((await f.status()).pendingApprovals.length, 0);
  }
});
