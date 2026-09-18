import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThreadRuntime } from "../thread-runtime.mjs";
import { createThreadService } from "../thread-service.mjs";
import { createThreadArtifacts } from "../thread-artifacts.mjs";
import { createTaskApi } from "../task-api.mjs";
import { createDiagnosticsApi } from "../diagnostics-api.mjs";
import { resumeThread } from "../protocol-adapter.mjs";

function runtimeFor(codex, options = {}) {
  return createThreadRuntime({ getCodex: () => codex, usesSharedDaemon: true,
    broadcast: () => {}, invalidateRecovery: () => {}, ...options });
}

test("task runtimes isolate ownership and queues and never recycle a shared daemon on release", async (t) => {
  const calls = [];
  const codex = { serverRequests: new Map(), subscribedThreads: new Set(["same-id"]),
    subscriptionSettings: new Map(), request: async (...args) => { calls.push(args); return {}; },
    recycle: () => assert.fail("shared daemon must not be recycled") };
  const first = runtimeFor(codex);
  const second = runtimeFor(codex);
  t.after(() => { first.resetThreadOwnership(); second.resetThreadOwnership(); });
  first.markThreadOwned("same-id");
  second.markThreadOwned("same-id");
  first.activeTurns.set("same-id", "turn");
  await assert.rejects(first.releaseThread("same-id"), { statusCode: 409 });
  assert.equal(calls.length, 0);
  assert.equal((await second.releaseThread("same-id")).status, "released");
  assert.deepEqual(calls, [["thread/unsubscribe", { threadId: "same-id" }]]);
  assert.equal(first.ownedThreads.has("same-id"), true);
  assert.equal(first.activeTurns.get("same-id"), "turn");
  assert.notEqual(first.threadMutationQueue, second.threadMutationQueue);
  first.scheduleThreadRelease("same-id", 60_000);
  first.resetThreadOwnership();
  assert.equal(first.ownedThreads.size, 0);
});

test("task service reads bounded origin metadata through promise-based files and rejects escaped sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pwa-service-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const path = join(sessions, "task.jsonl");
  const outside = join(root, "outside.jsonl");
  const line = JSON.stringify({ payload: { originator: "Codex Desktop" } }) + "\n";
  await writeFile(path, line);
  await writeFile(outside, line);
  await symlink(outside, join(sessions, "escape.jsonl"));
  const service = createThreadService({ codex: {}, codexHome: root, usesSharedDaemon: true,
    runtime: runtimeFor({}), taskRecovery: {}, isAllowedThreadPath: async () => true });
  assert.equal((await service.serializeThreadWithOrigin({ id: "task", source: "vscode", path })).clientOrigin, "windows");
  assert.equal((await service.serializeThreadWithOrigin({ id: "task", source: "vscode", path: join(sessions, "escape.jsonl") })).clientOrigin, "local-client");
  // A second instance must not reuse the first instance's metadata cache.
  await writeFile(path, JSON.stringify({ payload: { originator: "codex-tui" } }) + "\n");
  const second = createThreadService({ codex: {}, codexHome: root, usesSharedDaemon: true,
    runtime: runtimeFor({}), taskRecovery: {}, isAllowedThreadPath: async () => true });
  assert.equal((await second.serializeThreadWithOrigin({ id: "task", source: "vscode", path })).clientOrigin, "cli");
});

test("thread search matches recent user and assistant messages, enforces roots, and deduplicates archive buckets", async () => {
  const makeThread = (id, name, cwd, recencyAt, archived = false) => ({
    id, name, preview: name, cwd, recencyAt, updatedAt: recencyAt, archived,
    source: "appServer", threadSource: "codex-pwa-mobile", status: { type: "idle" },
  });
  const active = [
    makeThread("title-hit", "标题命中任务", "/allowed/project/title", 40),
    makeThread("user-hit", "普通任务一", "/allowed/project/user", 30),
    makeThread("assistant-hit", "普通任务二", "/allowed/project/assistant", 20),
    makeThread("duplicate", "重复任务", "/allowed/project/duplicate", 10),
    makeThread("outside", "外部秘密任务", "/outside/project", 50),
  ];
  const archived = [
    makeThread("duplicate", "重复任务（归档副本）", "/allowed/project/duplicate", 9, true),
  ];
  const messages = {
    "title-hit": [{ text: "标题任务的最新回复" }],
    "user-hit": [{ text: "用户最近消息包含蓝莓关键词" }],
    "assistant-hit": [{ text: "助手最近消息包含石榴关键词" }],
    duplicate: [{ text: "重复任务的最新消息" }],
    outside: [{ text: "外部秘密内容" }],
  };
  const calls = [];
  const codex = {
    request: async (method, params) => {
      calls.push([method, params]);
      assert.equal(method, "thread/list");
      const rows = params.archived ? archived : active;
      if (!params.searchTerm) return { data: rows };
      return { data: rows.filter((thread) => String(thread.name).includes(params.searchTerm)) };
    },
  };
  const runtime = runtimeFor(codex);
  const service = {
    allowedThread: async () => ({ id: "unused" }),
    requestThreadGoal: async () => ({ supported: false, goal: null }),
    requestThreadGoalBestEffort: async () => ({ supported: false, goal: null }),
    goalUnsupportedError: () => new Error("unsupported"),
    goalSetParams: () => ({}),
    readThreadTurnsPage: async () => ({ data: [] }),
    readRecentThreadMessages: async (threadId) => messages[threadId] || [],
    readActiveNarrative: async () => ({ data: [] }),
    syncActiveTurnFromHistory: async () => {},
    subscribeThread: async () => ({}),
    serializeThreadWithOrigin: async (thread) => ({ ...thread, clientOrigin: "mobile-web" }),
    threadWriteConflictError: (error) => error,
    readHistoryOutput: () => "",
  };
  let response;
  const api = createTaskApi({
    codex, runtime, service, artifacts: {}, roots: [], usesSharedDaemon: true,
    isAllowedThreadPath: async (cwd) => String(cwd).startsWith("/allowed/"),
    sendJson: (_response, status, body) => { response = { status, body }; },
    readBody: async () => ({}),
    broadcast: () => {},
  });
  const search = async (query, archivedMode = "all") => {
    await api.handleTaskApi({ method: "GET", headers: {} }, {},
      new URL(`http://localhost/api/thread-search?query=${encodeURIComponent(query)}&archived=${archivedMode}`),
      { kind: "disabled" });
    assert.equal(response.status, 200);
    return response.body.data;
  };
  assert.deepEqual((await search("标题命中")).map((thread) => thread.id), ["title-hit"]);
  assert.deepEqual((await search("蓝莓")).map((thread) => thread.id), ["user-hit"]);
  assert.deepEqual((await search("石榴")).map((thread) => thread.id), ["assistant-hit"]);
  assert.deepEqual(await search("不存在"), []);
  assert.deepEqual((await search("重复")).map((thread) => thread.id), ["duplicate"]);
  assert.deepEqual(await search("秘密"), []);
  assert.deepEqual(await search(""), []);
  assert.ok(calls.length >= 8, "search should read both ordinary and title candidates");
});

test("cached generated images recheck current task authorization before GET or HEAD", async () => {
  let allowed = true;
  let reads = 0;
  const artifacts = createThreadArtifacts({ codexHome: tmpdir(), allowedThread: async () => {
    reads += 1;
    if (!allowed) throw Object.assign(new Error("Thread is outside the allowed roots"), { statusCode: 403 });
    return { id: "task" };
  } });
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKioAAAAASUVORK5CYII=";
  const sanitized = artifacts.sanitizeNotificationForBrowser({ method: "item/completed", params: {
    threadId: "task", turnId: "turn", item: { type: "imageGeneration", id: "picture", status: "completed", result: image },
  } });
  assert.equal(sanitized.params.item.result, "");
  assert.ok(sanitized.params.item.artifact);
  const url = new URL("http://localhost/api/threads/task/artifacts/picture/raw");
  const response = { writeHead: () => {}, end: () => {} };
  await artifacts.sendThreadArtifact({ method: "GET" }, response, "task", "picture", url);
  allowed = false;
  const forbidden = { writeHead: () => assert.fail("headers leaked before authorization"), end: () => assert.fail("bytes leaked") };
  for (const method of ["GET", "HEAD"]) {
    await assert.rejects(artifacts.sendThreadArtifact({ method }, forbidden, "task", "picture", url), { statusCode: 403 });
  }
  assert.equal(reads, 3);
});

test("restoring an archived task checks authorization before daemon mutation and canonical roots afterwards", async () => {
  const calls = [];
  let allowed = false;
  let canonical = true;
  let response;
  const codex = { request: async (...args) => { calls.push(args); return { thread: { id: "task", cwd: "/project/link" } }; } };
  const { handleTaskApi } = createTaskApi({ codex, runtime: runtimeFor(codex), artifacts: {},
    service: { allowedThread: async () => {
      if (!allowed) throw Object.assign(new Error("outside roots"), { statusCode: 403 });
      return { id: "task" };
    }, serializeThreadWithOrigin: async (thread) => thread },
    isAllowedPath: () => true, isAllowedThreadPath: async () => canonical,
    sendJson: (_, status, value) => { response = { status, value }; },
  });
  const invoke = () => handleTaskApi({ method: "POST", headers: {} }, {}, new URL("http://localhost/api/threads/task/unarchive"), { kind: "disabled" });
  await assert.rejects(invoke(), { statusCode: 403 });
  assert.deepEqual(calls, [], "unauthorized request cannot reach unarchive");
  allowed = true;
  canonical = false;
  await assert.rejects(invoke(), { statusCode: 403 });
  assert.equal(response, undefined, "out-of-root response is not exposed");
  canonical = true;
  assert.equal(await invoke(), true);
  assert.equal(response.status, 200);
  assert.equal(response.value.thread.id, "task");
});

test("diagnostics read current roots, recovery, ownership and approval identity on every request", async () => {
  const codex = { status: "ready", ensureReady: async () => {}, serverRequests: new Map(), protocol: {} };
  const runtime = runtimeFor(codex);
  let broad = false;
  let recovery = { running: 0 };
  let value;
  const { handleDiagnosticsApi } = createDiagnosticsApi({ codex, runtime, roots: [],
    rootAccess: { snapshot: () => ({}), policy: () => ({ broad }) },
    sseReplay: { snapshot: () => ({ count: 0 }) }, taskRecovery: { snapshot: () => recovery },
    sendJson: (_, status, body) => { assert.equal(status, 200); value = body; },
  });
  const read = () => handleDiagnosticsApi({ method: "GET" }, {}, new URL("http://localhost/api/status"));
  await read();
  assert.equal(value.rootAccessPolicy.broad, false);
  assert.deepEqual(value.pendingApprovals, []);
  broad = true;
  recovery = { running: 1 };
  runtime.activeTurns.set("task", "turn");
  codex.serverRequests.set("0", { requestToken: "fresh-token", method: "item/fileChange/requestApproval",
    params: { threadId: "task" }, fileChangeContext: { complete: false } });
  await read();
  assert.equal(value.rootAccessPolicy.broad, true);
  assert.equal(value.taskRecovery.running, 1);
  assert.deepEqual(value.activeTurns, { task: "turn" });
  assert.equal(value.pendingApprovals[0].requestToken, "fresh-token");
  assert.deepEqual(value.pendingApprovals[0].fileChangeContext, { complete: false });
});

test("resume adapter retries only an unsupported excludeTurns field", async () => {
  const calls = [];
  const codex = { request: async (method, params) => {
    calls.push([method, params]);
    if (params.excludeTurns) throw Object.assign(new Error("unknown field excludeTurns"), { details: { code: -32602 } });
    return { thread: { id: "task" } };
  } };
  assert.equal((await resumeThread(codex, "task")).thread.id, "task");
  assert.deepEqual(calls, [["thread/resume", { threadId: "task", excludeTurns: true }], ["thread/resume", { threadId: "task" }]]);
  for (const error of [Object.assign(new Error("unknown field excludeTurns"), { details: { code: -32000 } }), new Error("connection lost")]) {
    let requests = 0;
    await assert.rejects(resumeThread({ request: async () => { requests += 1; throw error; } }, "task"), error);
    assert.equal(requests, 1, "a transport or different RPC error must not cause a second resume");
  }
});
