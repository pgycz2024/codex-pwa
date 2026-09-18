import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { Readable, Writable } from "node:stream";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findPendingUserMessageIndex,
  normalizeUserMessageText,
  reconcilePendingUserMessage,
} from "../public/message-reconcile.js";
import {
  chronologicalTurns,
  countDiffLines,
  nextDiffChunkEnd,
  transcriptSignature,
} from "../public/history-utils.js";
import { createMathExtensions } from "../public/markdown-math.js";
import { MAX_COLLAPSIBLE_REPLY_CHARS, longReplyPresentation } from "../public/message-display.js";
import { filePreviewHref, fileRawHref, normalizeMarkdownFileLinks, serverFilePath } from "../public/file-links.js";
import { Marked } from "marked";
import {
  contentDisposition,
  filePresentation,
  isCanonicalPathWithinRoots,
  isPathWithinRoots,
  parseByteRange,
} from "../file-access.mjs";
import { numberedUploadFilename, safeUploadFilename } from "../upload-utils.mjs";
import { appendUploadedFileReferences, formatUploadSize } from "../public/upload-utils.js";
import { directoryBreadcrumbs, validateDirectoryName } from "../directory-utils.mjs";
import { DEVICE_COOKIE, LoginRateLimiter, deviceCookie, parseCookies } from "../auth-store.mjs";
import {
  mergeThreadSettings,
  parseSettingsOverrides,
  permissionPresetFromSettings,
  serializeThreadSettings,
  threadStartPermission,
} from "../thread-settings.mjs";
import { inferClientOrigin, narrativeHistoryTurn } from "../thread-history.mjs";
import {
  decodedBase64Size,
  imagePresentationFromBase64,
  listRolloutArtifacts,
  readRolloutArtifact,
  scanRolloutArtifacts,
} from "../artifact-store.mjs";
import { readStoredStringArray } from "../public/storage-utils.js";
import {
  THREAD_TAGS_STORAGE_KEY,
  normalizeThreadTags,
  persistThreadTags,
  readStoredThreadTags,
} from "../public/thread-tags.js";
import { createEventDeduper, persistEventId, readStoredEventId } from "../public/event-session.js";
import { boundedWindow, fixedVirtualRange } from "../public/virtual-list.js";
import { modelDisplayName, resolveModel } from "../public/model-display.js";
import { buildActiveTaskSnapshot, readTaskSnapshot, reconcileTaskSnapshot } from "../public/task-snapshot.js";
import { createBrowserNotificationController } from "../public/browser-notifications.js";
import { approvalCommand, approvalDetail, approvalFilePaths, approvalRisk } from "../public/approval-policy.js";
import { createApiClient } from "../public/api-client.js";
import { deviceClientLabel } from "../public/device-manager.js";
import { FOCUSABLE_SELECTOR, installDialogFocus } from "../public/dialog-focus.js";
import {
  normalizeUnknownNotifications,
  readUnknownNotifications,
  recordUnknownNotification,
  summarizeUnknownNotifications,
} from "../public/notification-diagnostics.js";
import {
  normalizeThreadViewState,
  rememberThreadView,
  readThreadViewState,
} from "../public/thread-view-state.js";
import { parseEnvironmentFile } from "../scripts/read-env.mjs";
import { normalizeNotificationMethod, normalizeProtocolMessage, normalizeProtocolSnapshot } from "../protocol-adapter.mjs";
import { EventReplayBuffer } from "../event-replay.mjs";
import { ThreadMutationQueue } from "../thread-mutation-queue.mjs";
import { formatAbsolute, formatRelative, formatTimestampMs, normalizeEpochSeconds } from "../public/time-display.js";
import {
  THREAD_FILTERS,
  THREAD_LIST_MODES,
  isRecentThread,
  matchesThreadFilter,
  threadRecencyEpoch,
} from "../public/thread-list.js";
import { UI_COPY, uiText } from "../public/ui-copy.js";
import { normalizeErrorStatus, publicErrorMessage } from "../error-utils.mjs";
import { createFileApi } from "../file-api.mjs";
import { searchAllowedFiles } from "../file-search.mjs";
import { MAX_ADDITIONAL_ROOTS, RootAccessManager } from "../root-access.mjs";
import { WebSocketServer } from "ws";

const projectDirectory = dirname(fileURLToPath(new URL("../server.mjs", import.meta.url)));
const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

async function readProductSource(relative) {
  const source = await readFile(new URL(`../${relative}`, import.meta.url), "utf8");
  if (relative.endsWith(".html")) return source.replace(/<!--\/?copy(?::[\w.-]+)?-->/g, "").replace(/ data-copy-[\w-]+="[^"]*"/g, "");
  if (source.includes('import { uiText }')) return source + "\n" + Object.values(UI_COPY).join("\n");
  return source;
}

async function readServerSources() {
  const paths = ["server.mjs", "task-api.mjs", "thread-service.mjs", "thread-runtime.mjs",
    "thread-artifacts.mjs", "diagnostics-api.mjs", "protocol-adapter.mjs", "sse-events.mjs"];
  return (await Promise.all(paths.map((path) => readProductSource(path)))).join("\n");
}

async function readAppSources() {
  const paths = ["app.js", "diagnostics-view.js", "notification-handler.js", "task-composer.js"];
  return (await Promise.all(paths.map((path) => readProductSource(`public/${path}`)))).join("\n");
}

test("package, server, and documentation share one application version", async () => {
  const [lock, server, readme] = await Promise.all([
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
    readServerSources(),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  assert.match(packageManifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, packageManifest.version);
  assert.equal(lock.packages[""].version, packageManifest.version);
  assert.match(server, /APP_VERSION = JSON\.parse\(readFileSync\(join\(here, "package\.json"\)/);
  assert.doesNotMatch(server, /APP_VERSION = "\d+\.\d+\.\d+"/);
  assert.ok(readme.includes(`当前版本为 \`${packageManifest.version}\``));
});

test("protocol adapter normalizes initialize responses across CLI shapes", () => {
  const snapshot = normalizeProtocolSnapshot({
    protocolVersion: "0.153.2",
    serverInfo: { name: "codex", userAgent: "codex_cli_rs/0.153.2" },
    capabilities: { experimentalApi: true, goal: false, ignored: "value" },
  }, 1234);
  assert.equal(snapshot.protocolVersion, "0.153.2");
  assert.equal(snapshot.cliVersion, "0.153.2");
  assert.equal(snapshot.serverName, "codex");
  assert.deepEqual(snapshot.advertisedCapabilities, { experimentalApi: true, goal: false });
  assert.equal(snapshot.initializedAt, 1234);
  assert.equal(normalizeProtocolSnapshot(null, 1234).initializedAt, null);
  assert.equal(snapshot.bridgeCapabilities.eventReplay, true);
});

test("protocol adapter handles synthetic alternate initialize response shapes", () => {
  const fixtures = [
    {
      input: {
        protocol: { version: "0.148.0" },
        server: { name: "codex-legacy", version: "0.148.0" },
        userAgent: "codex_cli_rs/0.148.0",
        capabilities: { goal: true, threadHistory: false },
      },
      expected: {
        protocolVersion: "0.148.0",
        cliVersion: "0.148.0",
        appServerVersion: "0.148.0",
        serverName: "codex-legacy",
        advertisedCapabilities: { goal: true, threadHistory: false },
      },
    },
    {
      input: {
        protocolVersion: "0.153.2",
        serverInfo: { name: "codex-current", version: "0.153.2", cliVersion: "0.153.2" },
        capabilities: { modelSettings: true, serverRequests: true },
      },
      expected: {
        protocolVersion: "0.153.2",
        cliVersion: "0.153.2",
        appServerVersion: "0.153.2",
        serverName: "codex-current",
        advertisedCapabilities: { modelSettings: true, serverRequests: true },
      },
    },
  ];
  for (const { input, expected } of fixtures) {
    const snapshot = normalizeProtocolSnapshot(input, 42);
    assert.deepEqual({
      protocolVersion: snapshot.protocolVersion,
      cliVersion: snapshot.cliVersion,
      appServerVersion: snapshot.appServerVersion,
      serverName: snapshot.serverName,
      advertisedCapabilities: snapshot.advertisedCapabilities,
    }, expected);
    assert.equal(snapshot.initializedAt, 42);
    assert.equal(snapshot.bridgeCapabilities.threadHistory, true);
  }
  assert.deepEqual(normalizeProtocolSnapshot({ capabilities: { goal: "unknown" } }).advertisedCapabilities, {});
});

test("protocol adapter accepts nested and supports-prefixed capability shapes", () => {
  const snapshot = normalizeProtocolSnapshot({
    serverInfo: {
      capabilities: {
        advertised: { supportsGoal: true, supportsThreadHistory: false },
      },
    },
    capabilities: {
      methods: ["modelSettings", "serverRequests"],
    },
  }, 99);
  assert.deepEqual(snapshot.advertisedCapabilities, {
    goal: true,
    modelSettings: true,
    threadHistory: false,
    serverRequests: true,
  });
  const legacy = normalizeProtocolSnapshot({ advertisedCapabilities: { supportsGoal: false } });
  assert.deepEqual(legacy.advertisedCapabilities, { goal: false });
});

test("protocol adapter normalizes legacy notification method aliases", () => {
  assert.equal(normalizeNotificationMethod("turnStarted"), "turn/started");
  assert.equal(normalizeNotificationMethod("thread/statusChanged"), "thread/status/changed");
  assert.equal(normalizeNotificationMethod("future/notification"), "future/notification");
});

test("protocol adapter normalizes bridge messages before routing and preserves bounded diagnostics", () => {
  const message = normalizeProtocolMessage({ method: "turnStarted", params: { threadId: "task-1" } });
  assert.equal(message.method, "turn/started");
  assert.equal(message.originalMethod, "turnStarted");
  assert.deepEqual(message.params, { threadId: "task-1" });
  const unchanged = { method: "future/notification", params: {} };
  assert.equal(normalizeProtocolMessage(unchanged), unchanged);
  assert.equal(normalizeProtocolMessage(null), null);
});

test("app-server bridge routes through the protocol message adapter", async () => {
  const bridge = await readFile(new URL("../app-server-bridge.mjs", import.meta.url), "utf8");
  assert.match(bridge, /normalizeProtocolMessage, normalizeProtocolSnapshot/);
  assert.match(bridge, /message = normalizeProtocolMessage\(JSON\.parse\(line\)\)/);
});

test("approval policy extracts bounded details and highlights destructive changes", () => {
  const approval = {
    method: "item/fileChange/requestApproval",
    params: {
      command: ["bash", "-lc", "cat input > output"],
      changes: [{ path: "/srv/project/output.txt", action: "overwrite" }],
    },
  };
  assert.equal(approvalCommand(approval), "bash -lc cat input > output");
  assert.equal(approvalDetail(approval), "bash -lc cat input > output");
  assert.match(approvalDetail({ params: { changes: [{ path: "/srv/project/output.txt" }] } }), /output\.txt/);
  assert.deepEqual(approvalFilePaths(approval), ["/srv/project/output.txt"]);
  assert.deepEqual(approvalRisk(approval), { level: "high", label: "高风险操作" });
  assert.deepEqual(approvalRisk({ method: "item/fileChange/requestApproval", params: { changes: [{ action: "delete" }] } }),
    { level: "high", label: "可能覆盖或删除" });
});

test("thread list policy module keeps recent, unread, project, tag, and status filters bounded", () => {
  assert.equal(THREAD_LIST_MODES.has("recent"), true);
  assert.equal(THREAD_FILTERS.has("waiting"), true);
  const thread = { id: "task-1", cwd: "/srv/project", recencyAt: 1_000, status: { type: "waiting" } };
  assert.equal(threadRecencyEpoch(thread), 1_000);
  assert.equal(isRecentThread(thread, 1_000 + 6 * 24 * 60 * 60), true);
  assert.equal(isRecentThread(thread, 1_000 + 8 * 24 * 60 * 60), false);
  const tagsByThread = new Map([["task-1", ["重点"]]]);
  const options = {
    project: "/srv/project",
    tag: "重点",
    tagsByThread,
    statusType: (status) => status?.type || "",
  };
  assert.equal(matchesThreadFilter(thread, { ...options, filter: "all" }), true);
  assert.equal(matchesThreadFilter(thread, { ...options, filter: "waiting" }), true);
  assert.equal(matchesThreadFilter(thread, { ...options, filter: "unread", unreadThreads: new Set(["task-1"]) }), true);
  assert.equal(matchesThreadFilter(thread, { ...options, project: "/srv/other" }), false);
  assert.equal(matchesThreadFilter(thread, { ...options, tag: "普通" }), false);
});

test("device client labels remain useful across common mobile and desktop user agents", () => {
  assert.equal(deviceClientLabel("Mozilla/5.0 (Linux; Android 14) Chrome/123.0"), "Android · Chrome");
  assert.equal(deviceClientLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Safari/605.1"), "iOS / iPadOS · Safari");
  assert.equal(deviceClientLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/123.0"), "Windows · Edge");
  assert.equal(deviceClientLabel("unknown-client"), "浏览器 · Web");
});

test("API client centralizes CSRF, unauthorized, and network failure handling", async () => {
  let request = null;
  const connectionStates = [];
  const client = createApiClient({
    getAuth: () => ({ authenticated: true, csrfToken: "csrf-token" }),
    setConnection: (...value) => connectionStates.push(value),
    fetchImpl: async (path, options) => {
      request = { path, options };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.deepEqual(await client("/api/threads/1", { method: "POST", body: "{}" }), { ok: true });
  assert.equal(request.options.headers["X-Codex-PWA-CSRF"], "csrf-token");
  assert.equal(request.options.credentials, "same-origin");

  const unauthorized = createApiClient({
    getAuth: () => ({ authenticated: true, csrfToken: "csrf-token" }),
    onUnauthorized: (message) => connectionStates.push(["unauthorized", message]),
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "登录已过期" }),
    }),
  });
  await assert.rejects(() => unauthorized("/api/threads"), /登录已过期/);
  assert.deepEqual(connectionStates.at(-1), ["unauthorized", "登录已过期"]);

  const offline = createApiClient({
    getAuth: () => ({ authenticated: true }),
    setConnection: (...value) => connectionStates.push(value),
    fetchImpl: async () => { throw new Error("connection refused"); },
  });
  await assert.rejects(() => offline("/api/threads"), /connection refused/);
  assert.deepEqual(connectionStates.at(-1), ["offline", "无法连接服务器，请检查网络：connection refused"]);
});

test("SSE replay buffer bounds events and reports replay gaps", () => {
  const replay = new EventReplayBuffer({ maxEvents: 2, maxBytes: 1_000_000 });
  replay.append({ kind: "one" });
  replay.append({ kind: "two" });
  replay.append({ kind: "three" });
  replay.append({ kind: "four" });
  assert.deepEqual(replay.after(2).events.map((event) => event.id), [3, 4]);
  assert.equal(replay.after(1).gap, true);
  assert.equal(replay.after(2).gap, false);
  assert.match(replay.after(2).events[0].frame, /^id: 3\ndata:/);
  const tiny = new EventReplayBuffer({ maxEvents: 10, maxBytes: 20 });
  tiny.append({ text: "this event is larger than the byte window" });
  assert.equal(tiny.events.length, 0);
});

test("SSE replay buffer restores a bounded event window after a process restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-persisted-replay-"));
  const persistencePath = join(root, "events.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new EventReplayBuffer({ maxEvents: 2, maxBytes: 1_000_000, persistencePath });
  first.append({ kind: "one" });
  first.append({ kind: "two" });
  first.append({ kind: "three" });
  const restarted = new EventReplayBuffer({ maxEvents: 2, maxBytes: 1_000_000, persistencePath });
  assert.deepEqual(restarted.after(1).events.map((event) => event.id), [2, 3]);
  assert.equal(restarted.after(1).gap, false);
  assert.equal(restarted.append({ kind: "four" }).id, 4);
  assert.deepEqual(new EventReplayBuffer({ maxEvents: 2, maxBytes: 1_000_000, persistencePath }).after(2).events.map((event) => event.id), [3, 4]);
});

test("SSE replay diagnostics expose bounded persistence metadata", () => {
  const replay = new EventReplayBuffer({ maxEvents: 2, maxBytes: 1024 });
  replay.append({ kind: "one" });
  const snapshot = replay.snapshot();
  assert.deepEqual(snapshot, {
    persistent: false,
    count: 1,
    bytes: replay.bytes,
    oldestId: 1,
    newestId: 1,
    maxEvents: 2,
    maxBytes: 1024,
  });
});

test("thread mutation queue serializes one task while allowing independent tasks", async () => {
  const queue = new ThreadMutationQueue();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.run("thread-a", async () => {
    events.push("a:start");
    await gate;
    events.push("a:end");
    return "a";
  });
  const second = queue.run("thread-a", async () => {
    events.push("a2");
    return "a2";
  });
  const independent = queue.run("thread-b", async () => {
    events.push("b");
    return "b";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["a:start", "b"]);
  release();
  assert.deepEqual(await Promise.all([first, second, independent]), ["a", "a2", "b"]);
  assert.deepEqual([...queue.keys()], []);
});

test("thread tag storage normalizes bounded local-only labels", () => {
  const values = new Map([
    ["thread-a", [" 待复核 ", "待复核", "论文", "优先", "第四", "第五", "第六"]],
    ["thread-empty", ["", "   "]],
  ]);
  const storageValues = new Map();
  const storage = {
    getItem: (key) => storageValues.get(key) || null,
    setItem: (key, value) => storageValues.set(key, value),
    removeItem: (key) => storageValues.delete(key),
  };
  assert.deepEqual(normalizeThreadTags("待复核, 论文, 待复核"), ["待复核", "论文"]);
  assert.deepEqual(persistThreadTags(storage, values), {
    "thread-a": ["待复核", "论文", "优先", "第四", "第五"],
  });
  assert.equal(storageValues.has(THREAD_TAGS_STORAGE_KEY), true);
  assert.deepEqual(readStoredThreadTags(storage), {
    "thread-a": ["待复核", "论文", "优先", "第四", "第五"],
  });
  storage.setItem(THREAD_TAGS_STORAGE_KEY, "{bad json");
  assert.deepEqual(readStoredThreadTags(storage), {});
});

test("SSE cursor survives a page refresh within the browser session", async () => {
  const [app, eventConnection] = await Promise.all([
    readAppSources(),
    readProductSource("public/event-connection.js"),
  ]);
  assert.match(app, /event-session\.js/);
  assert.match(app, /lastEventId: readStoredEventId\(sessionStorage\)/);
  assert.match(app, /createEventConnectionManager/);
  assert.match(eventConnection, /persistEventId\(sessionStorageRef, state\.lastEventId\)/);
  assert.match(app, /eventDeduper: createEventDeduper\(\)/);
  assert.match(eventConnection, /state\.eventDeduper\.add\(eventId\)/);
  assert.match(eventConnection, /runVisibleRecovery\(\)/);
});

test("event session cursor and deduplication remain bounded", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(readStoredEventId(storage), 0);
  assert.equal(persistEventId(storage, 42), true);
  assert.equal(readStoredEventId(storage), 42);
  assert.equal(persistEventId(storage, -1), false);
  const deduper = createEventDeduper(2);
  assert.equal(deduper.add(1), true);
  assert.equal(deduper.add(1), false);
  assert.equal(deduper.add(2), true);
  assert.equal(deduper.add(3), true);
  assert.equal(deduper.has(1), false);
  assert.equal(deduper.has(2), true);
  assert.equal(deduper.size(), 2);
});

test("message display policy folds only completed long replies", () => {
  assert.equal(longReplyPresentation("short").collapsible, false);
  const longText = "x".repeat(MAX_COLLAPSIBLE_REPLY_CHARS + 1);
  assert.deepEqual(longReplyPresentation(longText), {
    collapsible: true,
    expanded: false,
    buttonLabel: "展开完整回复",
  });
  assert.deepEqual(longReplyPresentation(longText, true), {
    collapsible: true,
    expanded: true,
    buttonLabel: "收起完整回复",
  });
  assert.equal(longReplyPresentation("short", true).expanded, false);
});

test("task snapshot module bounds storage and reconciles restart state", () => {
  const storage = { getItem: () => JSON.stringify([{ id: "a", status: "active", at: 1 }, { id: 42 }, { id: "b" }]) };
  assert.deepEqual(readTaskSnapshot(storage, "tasks"), [
    { id: "a", status: "active", at: 1 },
    { id: "b", status: "active", at: 0 },
  ]);
  const current = buildActiveTaskSnapshot([
    { id: "a", status: { type: "active" } },
    { id: "c", status: { type: "idle" } },
    { id: "d", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
  ], (status) => status.type === "active" && status.activeFlags?.length ? "waiting" : status.type, 123);
  assert.deepEqual(current, [
    { id: "a", status: "active", at: 123 },
    { id: "d", status: "waiting", at: 123 },
  ]);
  assert.deepEqual(reconcileTaskSnapshot(
    [{ id: "a" }, { id: "b" }], current, [{ id: "a" }, { id: "b" }],
  ), { stillRunning: [{ id: "a" }], waiting: [], inactive: [], errors: [], unconfirmed: [{ id: "b" }] });
});

test("browser notification controller enforces secure context, focus, and rate limits", async () => {
  const notices = [];
  let clock = 1_000;
  class FakeNotification {
    static permission = "granted";
    static requestPermission = async () => "granted";
    constructor(title, options) { this.title = title; this.options = options; notices.push(this); }
    close() { this.closed = true; }
  }
  const environment = { isSecureContext: true, Notification: FakeNotification, focus: () => { environment.focused = true; } };
  const opened = [];
  const controller = createBrowserNotificationController({
    environment,
    getSelectedThreadId: () => "selected",
    onOpen: (threadId) => opened.push(threadId),
    now: () => clock,
  });
  assert.equal(controller.available(), true);
  assert.equal(await controller.send({ threadId: "background", title: "完成", body: "结果" }), true);
  assert.equal(await controller.send({ threadId: "background", title: "完成", body: "重复" }), false);
  assert.equal(await controller.send({ threadId: "selected", title: "当前", body: "忽略" }), false);
  notices[0].onclick();
  assert.deepEqual(opened, ["background"]);
  assert.equal(environment.focused, true);
  clock += 30_000;
  assert.equal(await controller.send({ threadId: "background", title: "完成", body: "再次" }), true);
  const insecure = createBrowserNotificationController({ environment: { isSecureContext: false, Notification: FakeNotification } });
  assert.equal(insecure.available(), false);
  assert.equal(await insecure.send({ threadId: "background", title: "忽略", body: "忽略" }), false);
});

test("browser notification rate limits survive refresh with bounded local state", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  let clock = 10_000;
  class FakeNotification {
    static permission = "granted";
    constructor() {}
  }
  const first = createBrowserNotificationController({
    environment: { isSecureContext: true, Notification: FakeNotification },
    storage,
    now: () => clock,
  });
  assert.equal(await first.send({ threadId: "task-a", title: "完成", body: "结果" }), true);
  const persisted = JSON.parse(values.get("codex-pwa-notification-times"));
  assert.deepEqual(Object.keys(persisted), ["task-a"]);
  const refreshed = createBrowserNotificationController({
    environment: { isSecureContext: true, Notification: FakeNotification },
    storage,
    now: () => clock,
  });
  assert.equal(await refreshed.send({ threadId: "task-a", title: "完成", body: "重复" }), false);
  clock += 30_000;
  assert.equal(await refreshed.send({ threadId: "task-a", title: "完成", body: "再次" }), true);
  const bounded = JSON.parse(values.get("codex-pwa-notification-times"));
  assert.ok(Object.keys(bounded).length <= 256);
});

test("unknown notification diagnostics persist only bounded method summaries", () => {
  const storageValues = new Map([["diagnostics", JSON.stringify({
    "thread/new-event": { count: 2, lastAt: 20 },
    "": { count: 99, lastAt: 30 },
    "bad": { count: -1, lastAt: 40 },
  })]]);
  const storage = {
    getItem: (key) => storageValues.get(key) || null,
    setItem: (key, value) => storageValues.set(key, value),
    removeItem: (key) => storageValues.delete(key),
  };
  const initial = readUnknownNotifications(storage, "diagnostics");
  assert.deepEqual([...initial.entries()], [["thread/new-event", { count: 2, lastAt: 20 }]]);
  const next = recordUnknownNotification(initial, "thread/new-event", 50);
  assert.deepEqual(next.get("thread/new-event"), { count: 3, lastAt: 50 });
  assert.deepEqual(summarizeUnknownNotifications(next), {
    methodCount: 1,
    totalCount: 3,
    latestAt: 50,
    entries: [{ method: "thread/new-event", count: 3, lastAt: 50 }],
  });
  assert.equal(normalizeUnknownNotifications({ ["x".repeat(181)]: { count: 1, lastAt: 1 } }).size, 0);
});

test("thread view state keeps a bounded scroll position without transcript data", () => {
  const values = new Map([["views", JSON.stringify({ task: { ratio: 0.4, bottom: false, at: 10 } })]]);
  const storage = { getItem: (key) => values.get(key) || null, removeItem: () => {} };
  const state = readThreadViewState(storage, "views");
  assert.deepEqual(state.task, { ratio: 0.4, bottom: false, at: 10 });
  const next = rememberThreadView(state, "task", { ratio: 9, bottom: true, at: 20 });
  assert.deepEqual(next.task, { ratio: 1, bottom: true, at: 20 });
  assert.deepEqual(normalizeThreadViewState({ bad: { ratio: 2, at: 1 } }), {});
});

test("login rate limiting isolates ordinary clients while retaining a bounded key set", () => {
  const limiter = new LoginRateLimiter({ maxFailures: 2, windowMs: 1_000, maxKeys: 2 });
  limiter.recordFailure("phone-a", 0);
  limiter.recordFailure("phone-a", 10);
  assert.equal(limiter.retryAfterSeconds("phone-a", 20), 1);
  assert.equal(limiter.retryAfterSeconds("phone-b", 20), 0);
  limiter.reset("phone-a");
  assert.equal(limiter.retryAfterSeconds("phone-a", 20), 0);
  limiter.recordFailure("phone-b", 20);
  limiter.recordFailure("phone-c", 20);
  limiter.recordFailure("phone-d", 20);
  assert.ok(limiter.failures.size <= 2);
});

async function reserveLocalPort() {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

async function waitForHttp(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for the test server");
}

async function rawHttpRequest(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", reject);
  });
}

test("corrupt legacy browser state falls back without preventing startup", () => {
  const values = new Map([["pins", "{broken"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
  };
  assert.deepEqual(readStoredStringArray(storage, "pins"), []);
  assert.equal(values.has("pins"), false);
  values.set("pins", JSON.stringify(["thread-1", 42, "thread-2"]));
  assert.deepEqual(readStoredStringArray(storage, "pins"), ["thread-1", "thread-2"]);
});

test("history virtualization bounds DOM-sized windows for very long tasks", () => {
  assert.deepEqual(boundedWindow(12_500, 160), { start: 12_340, end: 12_500, enabled: true });
  assert.deepEqual(boundedWindow(12_500, 160, 4_000), { start: 4_000, end: 4_160, enabled: true });
  assert.deepEqual(boundedWindow(20, 160), { start: 0, end: 20, enabled: false });
  assert.deepEqual(fixedVirtualRange({
    total: 12_500, scrollTop: 5_800, rowHeight: 58, viewportHeight: 580, overscan: 12,
  }), { start: 88, end: 122 });
  assert.deepEqual(fixedVirtualRange({
    total: 20, scrollTop: 50_000, rowHeight: 74, viewportHeight: 740, overscan: 2,
  }), { start: 8, end: 20 });
  assert.deepEqual(fixedVirtualRange({
    total: 0, scrollTop: 50_000, rowHeight: 74, viewportHeight: 740, overscan: 2,
  }), { start: 0, end: 0 });
});

test("active transcript comparison detects same-length corrections and non-message changes", () => {
  const turn = { id: "active", status: "inProgress", items: [
    { id: "reply", type: "agentMessage", text: "first" },
    { id: "command", type: "commandExecution", status: "inProgress", aggregatedOutput: "start" },
    { id: "tool", type: "mcpToolCall", result: { count: 1 } },
  ] };
  const original = transcriptSignature(turn);
  assert.equal(transcriptSignature(structuredClone(turn)), original);
  for (const edit of [
    (next) => { next.items[0].text = "other"; },
    (next) => { next.items[1].aggregatedOutput = "ended"; },
    (next) => { next.items[1].status = "completed"; },
    (next) => { next.items[2].result.count = 2; },
  ]) {
    const next = structuredClone(turn); edit(next);
    assert.notEqual(transcriptSignature(next), original);
  }
  assert.equal(transcriptSignature({ ...turn, text: "x".repeat(65_536) }), null,
    "oversized snapshots bypass deduplication instead of retaining an unbounded signature");
});

test("environment-file parser treats shell syntax as inert data", () => {
  const parsed = parseEnvironmentFile([
    'CODEX_PWA_PORT="4177"',
    'CODEX_PWA_INSTANCE_NAME="$(touch /tmp/never-run)"',
    'CODEX_PWA_NETWORK_LABEL="literal `command`"',
    'UNRELATED_SECRET="ignored"',
  ].join("\n"));
  assert.equal(parsed.get("CODEX_PWA_PORT"), "4177");
  assert.equal(parsed.get("CODEX_PWA_INSTANCE_NAME"), "$(touch /tmp/never-run)");
  assert.equal(parsed.get("CODEX_PWA_NETWORK_LABEL"), "literal `command`");
  assert.equal(parsed.has("UNRELATED_SECRET"), false);
});

test("PWA manifest is valid JSON and standalone", async () => {
  const manifest = JSON.parse(await readProductSource("public/manifest.webmanifest"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
});

test("distribution build uses per-user runtime defaults instead of personal paths and addresses", async () => {
  const [server, app, html, unit] = await Promise.all([
    readServerSources(),
    readAppSources(),
    readProductSource("public/index.html"),
    readFile(new URL("../systemd/codex-pwa.service", import.meta.url), "utf8"),
  ]);
  for (const source of [server, app, html, unit]) {
    assert.doesNotMatch(source, /\/home\/dell/);
    assert.doesNotMatch(source, /172\.16\.2\.53/);
  }
  assert.match(server, /process\.env\.HOME \|\| process\.cwd\(\)/);
  assert.match(server, /CODEX_PWA_INSTANCE_NAME/);
  assert.match(server, /CODEX_PWA_NETWORK_LABEL/);
  assert.match(html, /id="instanceName"/);
  assert.match(html, /id="networkLabel"/);
  assert.match(app, /status\.instanceName/);
  assert.match(app, /status\.networkLabel/);
});

test("doctor supports legacy inline service environments", async () => {
  const doctor = await readFile(new URL("../scripts/doctor.sh", import.meta.url), "utf8");
  assert.match(doctor, /project_root=\$\(cd -- "\$script_dir\/\.\."/);
  assert.match(doctor, /Source commit/);
  assert.match(doctor, /uncommitted or untracked changes/);
  assert.match(doctor, /Configuration format v1/);
  assert.match(doctor, /Allowed roots/);
  assert.match(doctor, /root_accessible/);
  assert.match(doctor, /readable\/searchable/);
  assert.match(doctor, /cover the entire user home/);
  assert.match(doctor, /Service Worker cache/);
  assert.match(doctor, /sed -n 's\/\^const CACHE/);
  assert.match(doctor, /PWA service WorkingDirectory/);
  assert.match(doctor, /MainPID/);
  assert.match(doctor, /Running Web UI version/);
  assert.match(doctor, /api\/status/);
  assert.match(doctor, /runtime_status_json/);
  assert.match(doctor, /SSE replay file/);
  assert.match(doctor, /expected 600/);
  assert.match(doctor, /runtime_health_json/);
  assert.match(doctor, /Remote main/);
  assert.match(doctor, /Remote release/);
  assert.match(doctor, /timeout 5s git ls-remote/);
  assert.match(doctor, /systemctl --user show codex-pwa\.service/);
  assert.match(doctor, /legacy inline codex-pwa\.service environment/);
  assert.match(doctor, /while IFS=\$'\\t' read -r name value/);
  assert.doesNotMatch(doctor, /eval \"unit_assignments=/);
  assert.doesNotMatch(doctor, /source \"\$env_file\"/);
  assert.match(doctor, /api\/health/);
});

test("ZIP distribution excludes Git history and has atomic update and compatible uninstall paths", async () => {
  const [release, update, uninstall, publish, releaseWorkflow] = await Promise.all([
    readFile(new URL("../scripts/make-release.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/update-user.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/uninstall-user.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/publish-mirror.sh", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  ]);
  assert.match(release, /codex-pwa-\$tag\.zip/);
  assert.match(release, /codex-pwa-\$tag-clean-git\.bundle/);
  assert.match(release, /RELEASE-MANIFEST\.sha256/);
  assert.match(release, /--verify-only/);
  assert.match(release, /Release verification passed/);
  assert.match(release, /git -C "\$package_root" init -q -b main/);
  assert.match(release, /git -C "\$package_root" bundle create/);
  assert.match(release, /thread-mutation-queue\.mjs/);
  assert.match(release, /app-server-bridge\.mjs/);
  assert.match(release, /sse-events\.mjs/);
  assert.match(release, /error-utils\.mjs/);
  assert.match(release, /static-server\.mjs/);
  assert.match(release, /bundle create "\$bundle" HEAD main "\$tag"/);
  assert.doesNotMatch(release, /git bundle create --all/);
  assert.match(release, /git status --porcelain --untracked-files=all/);
  assert.match(release, /tag %s must exist and point to HEAD/);
  assert.match(release, /sha256sum "\$\(basename -- "\$archive"\)"/);
  assert.match(release, /possible %s found in/);
  assert.match(release, /symbolic links are not allowed/);
  assert.match(update, /--zip/);
  assert.match(update, /Candidate health check failed; restoring the previous version/);
  assert.match(update, /mv -- \"\$backup\" \"\$app_dir\"/);
  assert.match(update, /\/api\/health/);
  assert.match(update, /resolve_health_port/);
  assert.match(update, /systemctl --user show codex-pwa\.service/);
  assert.match(update, /port=\$\(resolve_health_port \|\| true\)/);
  assert.match(update, /candidate_version=/);
  assert.match(update, /runtime_version/);
  assert.match(update, /sw\.js/);
  assert.match(update, /candidate_worker_hash/);
  assert.match(update, /verify_runtime "\$previous_version" "\$previous_worker_hash"/);
  assert.match(update, /prune_old_backups/);
  assert.match(uninstall, /codex-pwa-private\.service/);
  assert.match(uninstall, /codex-pwa-pgy\.socket/);
  assert.match(uninstall, /codex-pwa-pgy\.service/);
  assert.match(publish, /npm run release:local/);
  assert.match(publish, /rsync -a --delete --exclude='\/\.git\/'/);
  assert.match(publish, /git -C "\$mirror" push --atomic origin main "\$tag"/);
  assert.doesNotMatch(publish, /push .*--force/);
  assert.match(releaseWorkflow, /permissions:\s*\n\s*contents: write/);
  assert.match(releaseWorkflow, /node scripts\/run-ci-check\.mjs release:local/);
  assert.match(releaseWorkflow, /gh release create/);
});

test("ZIP updater resolves the health port from a legacy inline systemd environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-update-port-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  const fakeSystemctl = join(bin, "systemctl");
  await writeFile(fakeSystemctl, "#!/usr/bin/env bash\nprintf '%s\\n' 'NODE_ENV=production CODEX_PWA_PORT=4266 CODEX_PWA_ROOTS=/srv/example'\n");
  await chmod(fakeSystemctl, 0o755);
  const child = spawn("bash", [join(projectDirectory, "scripts", "update-user.sh"), "--health-port"], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "config"),
      // setup-node installs Node outside /usr/bin on GitHub-hosted runners.
      // Preserve the running Node binary while keeping the fake systemctl first.
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "4266");
});

test("service worker excludes API requests from cache handling", async () => {
  const source = await readProductSource("public/sw.js");
  assert.match(source, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /ASSET_PATHS/);
  assert.match(source, /!navigation && !ASSET_PATHS\.has/);
  assert.match(source, /url\.pathname !== "\/file-preview\.html"/);
  assert.match(source, /cached \|\| Response\.error\(\)/);
  assert.doesNotMatch(source, /cache\.put\(event\.request/);
});

test("dialog focus manager restores the trigger after modal close", async () => {
  assert.match(FOCUSABLE_SELECTOR, /button/);
  let initialFocusCount = 0;
  let triggerFocusCount = 0;
  const trigger = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{ width: 1 }],
    getAttribute: () => null,
    focus: () => { triggerFocusCount += 1; },
  };
  const initial = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{ width: 1 }],
    getAttribute: () => null,
    focus: () => { initialFocusCount += 1; },
  };
  const dialog = {
    open: false,
    contains: () => false,
    querySelector: () => initial,
    querySelectorAll: () => [initial],
    showModal() { this.open = true; },
    close() { this.open = false; },
    addEventListener() {},
  };
  installDialogFocus([dialog], { documentRef: { activeElement: trigger } });
  dialog.showModal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initialFocusCount, 1);
  dialog.close();
  assert.equal(triggerFocusCount, 1);
});

test("keyboard focus remains visibly outlined across interactive controls", async () => {
  const css = await readProductSource("public/styles.css");
  assert.match(css, /:where\(button, a, summary, input, select, textarea\):focus-visible/);
  assert.match(css, /outline-offset:\s*3px/);
});

test("primary muted text meets WCAG AA contrast in both themes", async () => {
  const css = await readProductSource("public/styles.css");
  const variable = (name, theme = "dark") => {
    const scope = theme === "light"
      ? css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1] || ""
      : css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] || "";
    return scope.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  };
  const luminance = (hex) => {
    const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset + 1, offset + 3), 16) / 255);
    const linear = channels.map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const contrast = (foreground, background) => {
    const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (high + 0.05) / (low + 0.05);
  };
  for (const theme of ["dark", "light"]) {
    const foreground = variable("muted-2", theme);
    const panel = variable("panel", theme);
    const sidebar = variable("sidebar", theme);
    assert.ok(foreground && panel && sidebar, `${theme} theme must define muted-2, panel, and sidebar`);
    assert.ok(contrast(foreground, panel) >= 4.5, `${theme} muted-2 on panel must meet WCAG AA`);
    assert.ok(contrast(foreground, sidebar) >= 4.5, `${theme} muted-2 on sidebar must meet WCAG AA`);
    for (const color of ["green", "blue", "amber", "red", "purple"]) {
      assert.ok(contrast(variable(color, theme), variable(`${color}-bg`, theme)) >= 4.5,
        `${theme} ${color} on ${color}-bg must meet WCAG AA`);
    }
    assert.ok(contrast(variable("action-text", theme), variable("action-bg", theme)) >= 4.5,
      `${theme} action text must meet WCAG AA on action button`);
    assert.ok(contrast(variable("action-text", theme), variable("action-bg-hover", theme)) >= 4.5,
      `${theme} action text must meet WCAG AA on hovered action button`);
  }
});

test("trusted-device cookie and parser use a strict HttpOnly 90-day boundary", () => {
  const header = deviceCookie("opaque token", { remember: true });
  assert.match(header, new RegExp(`^${DEVICE_COOKIE}=`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Max-Age=7776000/);
  assert.equal(parseCookies(`${DEVICE_COOKIE}=opaque%20token; theme=dark`)[DEVICE_COOKIE], "opaque token");
  assert.match(deviceCookie("", { clear: true }), /Max-Age=0/);
});

test("per-task settings preserve effective values until an explicit next-turn override", () => {
  const effective = serializeThreadSettings({
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: {
      type: "workspaceWrite", writableRoots: [], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    },
  });
  assert.equal(effective.permissionPreset, "request");
  const overrides = parseSettingsOverrides({ effort: "xhigh", permissionPreset: "auto" }, effective);
  assert.equal(overrides.rpc.effort, "xhigh");
  assert.equal(overrides.rpc.approvalsReviewer, "auto_review");
  assert.equal(overrides.rpc.sandboxPolicy.type, "workspaceWrite");
  const merged = mergeThreadSettings(effective, overrides.applied);
  assert.equal(merged.permissionPreset, "auto");
  assert.equal(merged.effort, "xhigh");
  assert.deepEqual(threadStartPermission("full"), {
    approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access",
  });
  assert.equal(permissionPresetFromSettings({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }), "full");
});

test("task settings retain models that are missing from the catalog", async () => {
  const nested = serializeThreadSettings({
    thread: {
      model: "gpt-6-astra",
      reasoningEffort: "xhigh",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite", writableRoots: [] },
    },
  });
  assert.equal(nested.model, "gpt-6-astra");
  assert.equal(nested.effort, "xhigh");
  assert.equal(nested.permissionPreset, "request");
  assert.equal(modelDisplayName("gpt-6-astra"), "GPT6-Astra");
  assert.equal(modelDisplayName("gpt-5.6-sol"), "GPT5.6-Sol");
  const resolved = resolveModel("gpt-6-astra", [{
    model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true,
  }]);
  assert.equal(resolved.model, "gpt-6-astra");
  assert.equal(resolved.displayName, "GPT6-Astra");
  assert.equal(resolveModel("", [{ model: "gpt-5.6-sol", isDefault: true }]).model, "gpt-5.6-sol");
  const app = await readAppSources();
  const settings = await readProductSource("public/task-settings.js");
  assert.match(app, /createTaskSettingsManager/);
  assert.match(settings, /el\("option", "", effortLabel\(selectedValue\)\)/);
});

test("active narrative keeps complete text while omitting heavy tool activity", () => {
  const turn = narrativeHistoryTurn({
    id: "turn-1",
    items: [
      { id: "u", type: "userMessage", text: "开始" },
      { id: "a1", type: "agentMessage", text: "中间输出 1" },
      { id: "cc", type: "ContextCompaction" },
      { id: "c", type: "commandExecution", aggregatedOutput: "large" },
      { id: "r", type: "reasoning", summary: ["分析"] },
      { id: "r2", type: "reasoning", content: ["继续分析"] },
      { id: "a2", type: "agentMessage", text: "中间输出 2" },
      { id: "f", type: "fileChange", changes: [] },
    ],
  });
  assert.deepEqual(turn.items.filter((item) => item.type === "agentMessage").map((item) => item.text), ["中间输出 1", "中间输出 2"]);
  assert.equal(turn.items.some((item) => item.type === "commandExecution"), false);
  assert.equal(turn.items.filter((item) => item.type === "reasoning").length, 1);
  assert.equal(turn.items.find((item) => item.type === "reasoning").mergedReasoningItems, 2);
  assert.equal(turn.items.some((item) => item.type === "ContextCompaction"), true);
  assert.equal(turn.items.some((item) => item.type === "historyNotice"), true);
});

test("task creation sources distinguish Windows, mobile Web, CLI, and subagents", () => {
  assert.equal(inferClientOrigin({ source: "vscode" }, "Codex Desktop"), "windows");
  assert.equal(inferClientOrigin({ source: "vscode", threadSource: "codex-pwa-mobile" }, "Codex Desktop"), "mobile-web");
  assert.equal(inferClientOrigin({ source: "cli" }, "codex-tui"), "cli");
  assert.equal(inferClientOrigin({ source: { subAgent: {} }, parentThreadId: "parent" }), "subagent");
});

test("Markdown renderer recognizes LaTeX and GFM tables without touching code spans", () => {
  const parser = new Marked({ breaks: true, gfm: true });
  parser.use({
    extensions: createMathExtensions((tex, displayMode) => (
      `<${displayMode ? "div" : "span"} class="math-test">${tex}</${displayMode ? "div" : "span"}>`
    )),
  });
  const html = parser.parse([
    "行内公式 \\(G_{ae}\\) 与 \\(T_a,T_i,T_o,T_e\\)。",
    "",
    "\\[",
    "\\boxed{\\partial_t \\mathbf{u} + \\nabla p = 0}",
    "\\]",
    "",
    "| 变量 | 含义 |",
    "| :--- | ---: |",
    "| \\(T_a\\) | 环境温度 |",
    "",
    "代码 `\\(not_math\\)` 不应渲染。",
  ].join("\n"));

  assert.match(html, /<table>/);
  assert.match(html, /<th[^>]*>变量<\/th>/);
  assert.match(html, /<div class="math-test">\\boxed/);
  assert.equal((html.match(/class="math-test"/g) || []).length, 4);
  assert.match(html, /<code>\\\(not_math\\\)<\/code>/);
});

test("PWA locally serves and caches Markdown and KaTeX assets", async () => {
  const [server, worker, renderer, html, staticServer] = await Promise.all([
    readServerSources(),
    readProductSource("public/sw.js"),
    readProductSource("public/markdown-renderer.js"),
    readProductSource("public/index.html"),
    readFile(new URL("../static-server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(server, /static-server\.mjs/);
  assert.match(server, /auth-api\.mjs/);
  assert.match(staticServer, /createStaticServer/);
  assert.match(staticServer, /cache-control/);
  assert.match(server, /node_modules[\s\S]*marked[\s\S]*dompurify[\s\S]*katex/);
  assert.match(staticServer, /"\.woff2": "font\/woff2"/);
  assert.match(renderer, /createMarkdownRenderer/);
  assert.match(renderer, /DOMPurify/);
  assert.match(renderer, /addMessageOutline/);
  assert.match(worker, /\/markdown-math\.js/);
  assert.match(worker, /\/markdown-renderer\.js/);
  assert.match(worker, /\/vendor\/katex\/katex\.mjs/);
  assert.match(html, /\/vendor\/katex\/katex\.min\.css/);
});

test("server file links become authenticated preview links only inside allowed roots", () => {
  const path = "/srv/example/research/paper/main.pdf";
  assert.equal(serverFilePath(path, ["/srv/example"]), path);
  assert.equal(serverFilePath(`file://${encodeURI(path)}`, ["/srv/example"]), path);
  assert.equal(serverFilePath("sandbox:/srv/example/paper/main.pdf", ["/srv/example"]), "/srv/example/paper/main.pdf");
  assert.equal(serverFilePath("/srv/example-other/private.pdf", ["/srv/example"]), null);
  assert.equal(serverFilePath("https://example.com/main.pdf", ["/srv/example"]), null);
  assert.equal(filePreviewHref(path), `/file-preview.html?path=${encodeURIComponent(path)}`);
  assert.equal(fileRawHref(path), `/api/files/raw?path=${encodeURIComponent(path)}`);
});

test("Markdown local-file links remain clickable when paths contain spaces or parentheses", () => {
  const source = [
    "[研究 PDF](/srv/example/research (copy 1)/paper/main file.pdf)",
    "[file](file:///srv/example/research (copy 1)/paper/main file.pdf)",
    "[sandbox](sandbox:/srv/example/research (copy 1)/paper/main file.pdf)",
    "```text",
    "[不要改写](/srv/example/research (copy 1)/paper/main file.pdf)",
    "```",
  ].join("\n");
  const normalized = normalizeMarkdownFileLinks(source);
  assert.match(normalized, /\[研究 PDF\]\(\/srv\/example\/research%20%28copy%201%29\/paper\/main%20file\.pdf\)/);
  assert.match(normalized, /\[file\]\(\/srv\/example\/research%20%28copy%201%29\/paper\/main%20file\.pdf\)/);
  assert.match(normalized, /\[sandbox\]\(\/srv\/example\/research%20%28copy%201%29\/paper\/main%20file\.pdf\)/);
  assert.match(normalized, /\[不要改写\]\(\/srv\/example\/research \(copy 1\)\/paper\/main file\.pdf\)/);
  const html = new Marked({ breaks: true, gfm: true }).parse(normalized);
  assert.equal((html.match(/<a href=/g) || []).length, 3);
  assert.match(html, /<a href="\/srv\/example\/research%20%28copy%201%29\/paper\/main%20file\.pdf">研究 PDF<\/a>/);
});

test("remote file access helpers enforce roots, safe types, and single byte ranges", () => {
  assert.equal(isPathWithinRoots("/srv/example/project/file.pdf", ["/srv/example"]), true);
  assert.equal(isPathWithinRoots("/srv/example/../../etc/passwd", ["/srv/example"]), false);
  assert.deepEqual(parseByteRange("bytes=0-99", 500), { kind: "range", start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-100", 500), { kind: "range", start: 400, end: 499 });
  assert.deepEqual(parseByteRange("bytes=900-", 500), { kind: "invalid" });
  assert.equal(filePresentation("paper.pdf").previewKind, "pdf");
  assert.equal(filePresentation("payload.html").previewKind, "download");
  assert.match(contentDisposition("/srv/example/研究.pdf", false), /^inline;[^\r\n]+filename\*=UTF-8''/);
});

test("canonical root checks reject symlink escapes while allowing deleted in-root task directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-root-test-"));
  const outside = await mkdtemp(join(tmpdir(), "codex-pwa-outside-test-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await symlink(outside, join(root, "outside-link"));
  assert.equal(await isCanonicalPathWithinRoots(join(root, "outside-link"), [root]), false);
  assert.equal(await isCanonicalPathWithinRoots(join(root, "outside-link", "missing"), [root], { allowMissing: true }), false);
  assert.equal(await isCanonicalPathWithinRoots(join(root, "deleted-project"), [root], { allowMissing: true }), true);
  assert.equal(await isCanonicalPathWithinRoots("relative/project", [root], { allowMissing: true }), false);
});

test("image-generation artifacts are recovered from rollout JSONL without exposing base64 metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-artifact-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rollout = join(root, "rollout-test.jsonl");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");
  await writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-08-09T00:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({ timestamp: "2026-08-09T00:00:01Z", type: "response_item", payload: { type: "image_generation_call", id: "image-1", status: "generating", revised_prompt: "mountain", result: png } }),
  ].join("\n"));
  assert.equal(decodedBase64Size(png), 12);
  assert.equal(imagePresentationFromBase64(png).mimeType, "image/png");
  const artifacts = await listRolloutArtifacts(rollout);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].turnId, "turn-1");
  assert.equal(artifacts[0].byteLength, 12);
  assert.equal(Object.hasOwn(artifacts[0], "result"), false);
  const recovered = await readRolloutArtifact(rollout, "image-1");
  assert.deepEqual(recovered.buffer, Buffer.from(png, "base64"));

  const initialScan = await scanRolloutArtifacts(rollout);
  await appendFile(rollout, `\n${JSON.stringify({ timestamp: "2026-08-09T00:01:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } })}\n${JSON.stringify({ timestamp: "2026-08-09T00:01:01Z", type: "response_item", payload: { type: "image_generation_call", id: "image-2", result: png } })}`);
  const incrementalScan = await scanRolloutArtifacts(rollout, {
    start: initialScan.scannedBytes,
    artifacts: initialScan.artifacts,
    activeTurnId: initialScan.activeTurnId,
  });
  assert.deepEqual(incrementalScan.artifacts.map((artifact) => artifact.id), ["image-1", "image-2"]);
  assert.equal(incrementalScan.artifacts[1].turnId, "turn-2");
  assert.ok(incrementalScan.scannedBytes > initialScan.scannedBytes);

  const thirdLine = JSON.stringify({
    timestamp: "2026-08-09T00:02:01Z",
    type: "response_item",
    payload: { type: "image_generation_call", id: "image-3", result: png },
  });
  const splitAt = Math.floor(thirdLine.length / 2);
  await appendFile(rollout, `\n${thirdLine.slice(0, splitAt)}`);
  const partialScan = await scanRolloutArtifacts(rollout, {
    start: incrementalScan.scannedBytes,
    artifacts: incrementalScan.artifacts,
    activeTurnId: incrementalScan.activeTurnId,
  });
  assert.deepEqual(partialScan.artifacts.map((artifact) => artifact.id), ["image-1", "image-2"]);
  assert.ok(partialScan.scannedBytes < partialScan.size, "unterminated JSON must remain eligible for rescan");
  await appendFile(rollout, `${thirdLine.slice(splitAt)}\n`);
  const completedScan = await scanRolloutArtifacts(rollout, {
    start: partialScan.scannedBytes,
    artifacts: partialScan.artifacts,
    activeTurnId: partialScan.activeTurnId,
  });
  assert.deepEqual(completedScan.artifacts.map((artifact) => artifact.id), ["image-1", "image-2", "image-3"]);
  assert.equal(completedScan.scannedBytes, completedScan.size);

  // A damaged rollout line must not prevent later valid artifacts from being
  // recovered after the writer resumes.
  await appendFile(rollout, `\n{ this is damaged JSON\n${"x".repeat(200_000)}\n${JSON.stringify({
    timestamp: "2026-08-09T00:03:01Z",
    type: "response_item",
    payload: { type: "image_generation_call", id: "image-after-corruption", result: png },
  })}\n`);
  const recoveredAfterCorruption = await scanRolloutArtifacts(rollout, {
    start: completedScan.scannedBytes,
    artifacts: completedScan.artifacts,
    activeTurnId: completedScan.activeTurnId,
  });
  assert.deepEqual(recoveredAfterCorruption.artifacts.map((artifact) => artifact.id), [
    "image-1", "image-2", "image-3", "image-after-corruption",
  ]);
});

test("file preview uses a realpath-checked API and local PDF.js worker", async () => {
  const [server, fileApi, app, renderer, worker, preview] = await Promise.all([
    readServerSources(),
    readProductSource("file-api.mjs"),
    readAppSources(),
    readProductSource("public/markdown-renderer.js"),
    readProductSource("public/sw.js"),
    readProductSource("public/file-preview.js"),
  ]);
  assert.match(fileApi, /resolveAllowedFile[\s\S]*await realpath\(candidate\)[\s\S]*isAllowedPath\(actual\)/);
  assert.match(fileApi, /\/api\/files\/raw/);
  assert.match(fileApi, /content-range/);
  assert.match(app, /createMarkdownRenderer/);
  assert.match(renderer, /serverFilePath[\s\S]*filePreviewHref/);
  assert.match(renderer, /image\.src\s*=\s*fileRawHref\(localPath\)/);
  assert.match(app, /suppressRedundantGeneratedArtifacts/);
  assert.match(worker, /\/file-preview\.js/);
  assert.match(preview, /pdf\.worker\.mjs/);
  assert.match(preview, /IntersectionObserver/);
  assert.match(preview, /PDF_PAGE_BATCH_SIZE = 100/);
  assert.match(preview, /appendPdfPageBatch/);
});

test("upload filenames are flattened, bounded, and never overwrite by name", () => {
  assert.equal(safeUploadFilename("../../实验数据.csv"), "实验数据.csv");
  assert.equal(safeUploadFilename("..\\..\\notes.txt"), "notes.txt");
  assert.equal(safeUploadFilename("..."), "uploaded-file");
  assert.ok(Buffer.byteLength(safeUploadFilename(`${"数".repeat(200)}.csv`)) <= 180);
  assert.equal(numberedUploadFilename("results.csv", 0), "results.csv");
  assert.equal(numberedUploadFilename("results.csv", 1), "results-2.csv");
});

test("uploaded files are appended to prompts as relative workspace references", () => {
  const prompt = appendUploadedFileReferences("请分析这些数据", [
    { relativePath: "experiment.csv" },
    { relativePath: "图片/样品.png" },
    { relativePath: "experiment.csv" },
  ]);
  assert.match(prompt, /^请分析这些数据/);
  assert.match(prompt, /- `experiment\.csv`/);
  assert.match(prompt, /- `图片\/样品\.png`/);
  assert.equal((prompt.match(/experiment\.csv/g) || []).length, 1);
  assert.equal(formatUploadSize(1024), "1.0 KB");
});

test("directory names and breadcrumbs are normalized safely", () => {
  assert.deepEqual(validateDirectoryName("  新项目  "), { ok: true, name: "新项目" });
  for (const invalid of ["", ".", "..", "nested/path", "nested\\path", "bad\u0000name"]) {
    assert.equal(validateDirectoryName(invalid).ok, false);
  }
  assert.equal(validateDirectoryName("数".repeat(100)).ok, false);
  assert.deepEqual(directoryBreadcrumbs("/srv/example/work/project", ["/srv/example"]), [
    { name: "example", path: "/srv/example" },
    { name: "work", path: "/srv/example/work" },
    { name: "project", path: "/srv/example/work/project" },
  ]);
  assert.deepEqual(directoryBreadcrumbs("/etc", ["/srv/example"]), []);
});

test("bounded file search preserves root context and hides sensitive entries by default", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-file-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project", "nested"), { recursive: true });
  await writeFile(join(root, "project", "nested", "report-final.md"), "report");
  await writeFile(join(root, "project", "notes.txt"), "notes");
  await writeFile(join(root, ".env"), "secret");
  await writeFile(join(root, "project", "credentials.json"), "secret");
  const sensitive = (name) => name === ".env" || name === "credentials.json";

  const visible = await searchAllowedFiles({ roots: [root], query: "report", sensitiveEntryName: sensitive });
  assert.equal(visible.results.length, 1);
  assert.equal(visible.results[0].relativePath, "project/nested/report-final.md");
  assert.equal(visible.results[0].root, root);
  assert.equal(visible.truncated, false);

  const hidden = await searchAllowedFiles({ roots: [root], query: "credentials", showHidden: true, sensitiveEntryName: sensitive });
  assert.equal(hidden.results[0].relativePath, "project/credentials.json");
  const bounded = await searchAllowedFiles({ roots: [root], query: "p", maxResults: 1, sensitiveEntryName: sensitive });
  assert.equal(bounded.results.length, 1);
  assert.equal(bounded.truncated, true);
});

test("authorized root manager persists only removable additions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-root-access-"));
  const extra = await mkdtemp(join(tmpdir(), "codex-pwa-root-extra-"));
  const config = join(root, "config", "authorized-roots.json");
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(extra, { recursive: true, force: true }),
  ]));
  const roots = [root];
  const manager = new RootAccessManager({ configuredRoots: [root], roots, home: root, persistedPath: config });
  assert.equal(manager.add(root).alreadyCovered, true);
  assert.equal(manager.add(extra).added, true);
  assert.deepEqual(roots, [root, extra]);
  assert.equal(manager.snapshot().configured[0].removable, false);
  assert.equal(manager.snapshot().additional[0].removable, true);
  assert.match(await readFile(config, "utf8"), new RegExp(extra.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(manager.remove(root).removed, false);
  assert.equal(manager.remove(extra).removed, true);
  assert.deepEqual(roots, [root]);
  assert.ok(MAX_ADDITIONAL_ROOTS >= 1);
});

test("directory API browses authorized roots and creates folders without overwriting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-directory-test-"));
  const extraRoot = await mkdtemp(join(tmpdir(), "codex-pwa-directory-extra-"));
  const configRoot = await mkdtemp(join(tmpdir(), "codex-pwa-directory-config-"));
  await mkdir(join(root, "visible"), { mode: 0o750 });
  await mkdir(join(root, "visible", "nested"), { recursive: true, mode: 0o750 });
  await writeFile(join(root, "visible", "nested", "report-final.md"), "report\n");
  await mkdir(join(root, ".hidden"), { mode: 0o750 });
  const unreadableDirectory = join(root, ".unreadable");
  await mkdir(unreadableDirectory, { mode: 0o750 });
  await chmod(unreadableDirectory, 0o000);
  await writeFile(join(root, "notes.txt"), "server file browser\n");
  await writeFile(join(root, ".private.txt"), "hidden\n");
  await writeFile(join(root, "access-password"), "secret\n");
  await writeFile(join(root, "certificate.pem"), "secret\n");
  await symlink(join(root, "visible"), join(root, "linked-directory"));
  await symlink(join(root, "notes.txt"), join(root, "linked-file.txt"));
  const port = await reserveLocalPort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      CODEX_PWA_HOST: "127.0.0.1",
      CODEX_PWA_PORT: String(port),
      CODEX_PWA_ROOTS: root,
      CODEX_PWA_ROOTS_FILE: join(configRoot, "authorized-roots.json"),
      CODEX_PWA_PASSWORD_FILE: "",
      CODEX_PWA_APP_SERVER_MODE: "shared-daemon",
      CODEX_PWA_DAEMON_SOCKET: join(root, "missing-daemon.sock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await chmod(unreadableDirectory, 0o750).catch(() => {});
    await rm(root, { recursive: true, force: true });
    await rm(extraRoot, { recursive: true, force: true });
    await rm(configRoot, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/directories?path=${encodeURIComponent(root)}`, child);

  let response = await fetch(`${base}/api/access-roots`);
  let payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.configured[0].path, root);
  assert.equal(payload.configured[0].removable, false);
  response = await fetch(`${base}/api/access-roots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: extraRoot }),
  });
  assert.equal(response.status, 403);
  response = await fetch(`${base}/api/access-roots`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Codex-PWA-Root-Change": "1" },
    body: JSON.stringify({ path: extraRoot }),
  });
  payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.added, true);
  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(extraRoot)}`);
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/access-roots`, {
    method: "DELETE",
    headers: { "content-type": "application/json", "X-Codex-PWA-Root-Change": "1" },
    body: JSON.stringify({ path: extraRoot }),
  });
  payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.removed, true);

  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}`);
  payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.entries.map((entry) => entry.name), ["visible"]);
  assert.equal(payload.path, root);
  assert.equal(payload.parent, null);

  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(unreadableDirectory)}`);
  payload = await response.json();
  assert.equal(response.status, 403);
  assert.equal(payload.error, "没有权限访问该路径；请检查目录权限或 CODEX_PWA_ROOTS 授权范围");

  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}&hidden=true`);
  payload = await response.json();
  assert.deepEqual(payload.entries.map((entry) => entry.name), [".hidden", ".unreadable", "visible"]);
  assert.equal(payload.entries.some((entry) => entry.name === "linked-directory"), false);

  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}&query=${encodeURIComponent("visi")}`);
  payload = await response.json();
  assert.deepEqual(payload.entries.map((entry) => entry.name), ["visible"]);

  response = await fetch(`${base}/api/files/list?path=${encodeURIComponent(root)}`);
  payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.entries.map((entry) => entry.name), ["visible", "notes.txt"]);
  assert.equal(payload.entries.find((entry) => entry.name === "visible").type, "directory");
  assert.equal(payload.entries.find((entry) => entry.name === "notes.txt").previewKind, "text");
  assert.equal(payload.entries.some((entry) => entry.name === "linked-file.txt"), false);

  response = await fetch(`${base}/api/files/list?path=${encodeURIComponent(root)}&hidden=true&query=private`);
  payload = await response.json();
  assert.deepEqual(payload.entries.map((entry) => entry.name), [".private.txt"]);

  response = await fetch(`${base}/api/files/list?path=${encodeURIComponent(root)}&query=access`);
  payload = await response.json();
  assert.deepEqual(payload.entries, []);

  response = await fetch(`${base}/api/files/search?query=report`);
  payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.results[0].relativePath, "visible/nested/report-final.md");
  assert.equal(payload.results[0].root, root);

  response = await fetch(`${base}/api/files/search?query=r`);
  payload = await response.json();
  assert.equal(response.status, 400);
  assert.match(payload.error, /至少需要 2/);

  response = await fetch(`${base}/api/files/list?path=${encodeURIComponent(root)}&hidden=true&query=access`);
  payload = await response.json();
  assert.equal(payload.entries[0].name, "access-password");
  assert.equal(payload.entries[0].sensitive, true);

  response = await fetch(`${base}/api/files/list?path=${encodeURIComponent(root)}&hidden=true&query=certificate`);
  payload = await response.json();
  assert.equal(payload.entries[0].name, "certificate.pem");
  assert.equal(payload.entries[0].sensitive, true);

  response = await fetch(`${base}/api/files/list?path=${encodeURIComponent(dirname(root))}`);
  assert.equal(response.status, 403);

  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(dirname(root))}`);
  assert.equal(response.status, 403);

  response = await fetch(`${base}/api/directories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: root, name: "created" }),
  });
  assert.equal(response.status, 403);

  response = await fetch(`${base}/api/directories`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Codex-PWA-Directory": "1" },
    body: JSON.stringify({ parent: root, name: "created" }),
  });
  payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.path, join(root, "created"));
  const details = await stat(payload.path);
  assert.equal(details.mode & 0o777, 0o750);
  const createdDirectory = payload.path;

  const upload = new FormData();
  upload.append("files", new Blob(["真实 multipart 上传测试\n"], { type: "text/plain" }), "测试附件.txt");
  response = await fetch(`${base}/api/files/upload?cwd=${encodeURIComponent(payload.path)}`, {
    method: "POST",
    headers: { "X-Codex-PWA-Upload": "1" },
    body: upload,
  });
  const uploadPayload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(uploadPayload.files.length, 1);
  assert.equal(uploadPayload.files[0].relativePath, "测试附件.txt");
  assert.equal(await readFile(join(payload.path, "测试附件.txt"), "utf8"), "真实 multipart 上传测试\n");

  const operate = (body) => fetch(`${base}/api/files/operations`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Codex-PWA-File-Operation": "1" },
    body: JSON.stringify(body),
  });
  response = await operate({ operation: "copy", path: join(root, "notes.txt"), targetDirectory: payload.path });
  assert.equal(response.status, 200);
  assert.equal(await readFile(join(payload.path, "notes.txt"), "utf8"), "server file browser\n");
  assert.equal((await readdir(payload.path)).some((name) => name.includes(".codex-pwa-copying-")), false);
  response = await operate({ operation: "rename", path: join(payload.path, "notes.txt"), name: "renamed.txt" });
  assert.equal(response.status, 200);
  response = await operate({ operation: "move", path: join(payload.path, "renamed.txt"), targetDirectory: join(root, "visible") });
  assert.equal(response.status, 200);
  assert.equal(await readFile(join(root, "visible", "renamed.txt"), "utf8"), "server file browser\n");

  await writeFile(join(root, "batch-copy-a.txt"), "copy-a\n");
  await writeFile(join(root, "batch-copy-b.txt"), "copy-b\n");
  response = await operate({ operation: "copy", paths: [join(root, "batch-copy-a.txt"), join(root, "batch-copy-b.txt")], targetDirectory: createdDirectory });
  payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.failed.length, 0);
  assert.equal(payload.results.length, 2);
  assert.equal(await readFile(join(createdDirectory, "batch-copy-a.txt"), "utf8"), "copy-a\n");
  response = await operate({ operation: "move", paths: [join(createdDirectory, "batch-copy-a.txt"), join(createdDirectory, "batch-copy-b.txt")], targetDirectory: join(root, "visible") });
  payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.failed.length, 0);
  assert.equal(await readFile(join(root, "visible", "batch-copy-a.txt"), "utf8"), "copy-a\n");

  await writeFile(join(root, "batch-a.txt"), "a\n");
  await writeFile(join(root, "batch-b.txt"), "b\n");
  response = await operate({ operation: "delete", paths: [join(root, "batch-a.txt"), join(root, "batch-b.txt")] });
  payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.deleted.sort(), [join(root, "batch-a.txt"), join(root, "batch-b.txt")].sort());
  assert.deepEqual(payload.failed, []);
  await assert.rejects(stat(join(root, "batch-a.txt")), { code: "ENOENT" });
  await assert.rejects(stat(join(root, "batch-b.txt")), { code: "ENOENT" });

  response = await fetch(`${base}/`);
  assert.equal(response.headers.get("cache-control"), "no-cache");

  const malformedHostResponse = await rawHttpRequest(
    port,
    "GET / HTTP/1.1\r\nHost: [bad\r\nConnection: close\r\n\r\n",
  );
  assert.match(malformedHostResponse, /^HTTP\/1\.1 200 /);
  assert.equal(child.exitCode, null);
  response = await fetch(`${base}/`);
  assert.equal(response.status, 200);

  response = await fetch(`${base}/api/directories`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Codex-PWA-Directory": "1" },
    body: JSON.stringify({ parent: root, name: "created" }),
  });
  assert.equal(response.status, 409);
});

test("trusted-device login protects APIs, enforces CSRF, and invalidates sessions after password changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-auth-test-"));
  const passwordPath = join(root, "access-password");
  const sessionPath = join(root, "trusted-devices.json");
  await writeFile(passwordPath, "initial-secret\n", { mode: 0o600 });
  const port = await reserveLocalPort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      CODEX_PWA_HOST: "127.0.0.1",
      CODEX_PWA_PORT: String(port),
      CODEX_PWA_ROOTS: root,
      CODEX_PWA_PASSWORD_FILE: passwordPath,
      CODEX_PWA_SESSION_FILE: sessionPath,
      CODEX_PWA_APP_SERVER_MODE: "shared-daemon",
      CODEX_PWA_DAEMON_SOCKET: join(root, "missing-daemon.sock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/`, child);

  let response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.has("www-authenticate"), false);

  response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 503);
  assert.notEqual((await response.json()).bridge, "ready");

  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "codex", password: "wrong", remember: true }),
  });
  assert.equal(response.status, 401);

  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Android Test Browser" },
    body: JSON.stringify({ username: "codex", password: "initial-secret", remember: true }),
  });
  const login = await response.json();
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  assert.equal(response.status, 200);
  assert.equal(login.authenticated, true);
  assert.equal(login.remembered, true);
  assert.match(response.headers.get("set-cookie"), /Max-Age=7776000/);

  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}`, { headers: { cookie } });
  assert.equal(response.status, 200);

  response = await fetch(`${base}/api/auth/devices`, { headers: { cookie } });
  let devices = await response.json();
  assert.equal(response.status, 200);
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0].current, true);
  assert.match(devices.devices[0].userAgent, /Android Test Browser/);
  assert.equal(Object.hasOwn(devices.devices[0], "tokenHash"), false);

  response = await fetch(`${base}/api/auth/devices/${encodeURIComponent(login.id)}`, {
    method: "PATCH",
    headers: {
      cookie,
      "content-type": "application/json",
      "X-Codex-PWA-CSRF": login.csrfToken,
    },
    body: JSON.stringify({ label: "我的手机" }),
  });
  let deviceUpdate = await response.json();
  assert.equal(response.status, 200);
  assert.equal(deviceUpdate.device.label, "我的手机");

  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Windows Chrome Test" },
    body: JSON.stringify({ username: "codex", password: "initial-secret", remember: true }),
  });
  const secondLogin = await response.json();
  const secondCookie = response.headers.get("set-cookie").split(";", 1)[0];
  assert.equal(response.status, 200);

  response = await fetch(`${base}/api/auth/devices`, { headers: { cookie } });
  devices = await response.json();
  assert.equal(devices.devices.length, 2);
  assert.equal(devices.devices.find((device) => device.id === login.id).label, "我的手机");
  assert.equal(devices.devices.find((device) => device.id === secondLogin.id).current, false);

  response = await fetch(`${base}/api/auth/logout-others`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "X-Codex-PWA-CSRF": login.csrfToken,
    },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revoked, 1);
  response = await fetch(`${base}/api/auth/session`, { headers: { cookie: secondCookie } });
  assert.equal(response.status, 401);

  response = await fetch(`${base}/api/directories`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "X-Codex-PWA-Directory": "1" },
    body: JSON.stringify({ parent: root, name: "missing-csrf" }),
  });
  assert.equal(response.status, 403);

  response = await fetch(`${base}/api/directories`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "X-Codex-PWA-Directory": "1",
      "X-Codex-PWA-CSRF": login.csrfToken,
    },
    body: JSON.stringify({ parent: root, name: "csrf-ok" }),
  });
  assert.equal(response.status, 201);
  assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);

  const basic = Buffer.from("codex:initial-secret").toString("base64");
  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}`, {
    headers: { authorization: `Basic ${basic}` },
  });
  assert.equal(response.status, 401);

  await writeFile(passwordPath, "replacement-secret\n", { mode: 0o600 });
  response = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(response.status, 401);

  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "codex", password: "replacement-secret", remember: true }),
  });
  const replacement = await response.json();
  const replacementCookie = response.headers.get("set-cookie").split(";", 1)[0];
  response = await fetch(`${base}/api/auth/logout-all`, {
    method: "POST",
    headers: {
      cookie: replacementCookie,
      "content-type": "application/json",
      "X-Codex-PWA-CSRF": replacement.csrfToken,
    },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  response = await fetch(`${base}/api/auth/session`, { headers: { cookie: replacementCookie } });
  assert.equal(response.status, 401);

  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "codex", password: "replacement-secret", remember: true }),
  });
  const credentialLogin = await response.json();
  const credentialCookie = response.headers.get("set-cookie").split(";", 1)[0];
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/auth/credentials/change`, {
    method: "POST",
    headers: { cookie: credentialCookie, "content-type": "application/json" },
    body: JSON.stringify({
      currentUsername: "codex",
      currentPassword: "replacement-secret",
      newUsername: "researcher",
      newPassword: "final-secret",
    }),
  });
  assert.equal(response.status, 403);
  response = await fetch(`${base}/api/auth/credentials/change`, {
    method: "POST",
    headers: {
      cookie: credentialCookie,
      "content-type": "application/json",
      "X-Codex-PWA-CSRF": credentialLogin.csrfToken,
    },
    body: JSON.stringify({
      currentUsername: "codex",
      currentPassword: "wrong-secret",
      newUsername: "researcher",
      newPassword: "final-secret",
    }),
  });
  assert.equal(response.status, 401);
  response = await fetch(`${base}/api/auth/credentials/change`, {
    method: "POST",
    headers: {
      cookie: credentialCookie,
      "content-type": "application/json",
      "X-Codex-PWA-CSRF": credentialLogin.csrfToken,
    },
    body: JSON.stringify({
      currentUsername: "codex",
      currentPassword: "replacement-secret",
      newUsername: "researcher",
      newPassword: "final-secret",
    }),
  });
  const changedCredentials = await response.json();
  assert.equal(response.status, 200);
  assert.equal(changedCredentials.username, "researcher");
  assert.equal(changedCredentials.sessionsRevoked, true);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  response = await fetch(`${base}/api/auth/session`, { headers: { cookie: credentialCookie } });
  assert.equal(response.status, 401);
  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "codex", password: "final-secret", remember: true }),
  });
  assert.equal(response.status, 401);
  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "researcher", password: "final-secret", remember: true }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/auth/credentials/change`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      currentUsername: "researcher",
      currentPassword: "final-secret",
      newUsername: "public-user",
      newPassword: "public-secret",
    }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "researcher", password: "public-secret", remember: true }),
  });
  assert.equal(response.status, 401);
  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "public-user", password: "public-secret", remember: true }),
  });
  assert.equal(response.status, 200);
});

test("app-server disconnect keeps the Web UI HTTP surface alive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-disconnect-test-"));
  const port = await reserveLocalPort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      CODEX_PWA_HOST: "127.0.0.1",
      CODEX_PWA_PORT: String(port),
      CODEX_PWA_ROOTS: root,
      CODEX_PWA_PASSWORD_FILE: "",
      CODEX_PWA_APP_SERVER_MODE: "shared-daemon",
      CODEX_PWA_DAEMON_SOCKET: join(root, "missing-daemon.sock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/`, child);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 503);
    assert.notEqual((await health.json()).bridge, "ready");
  }
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Codex Remote/);
  assert.equal(child.exitCode, null);
});

test("SSE reconnect replays notifications emitted while the browser was offline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-sse-replay-test-"));
  const daemonSocket = join(root, "daemon.sock");
  const daemonHttp = createHttpServer();
  const daemonWs = new WebSocketServer({ server: daemonHttp });
  let daemonConnection = null;
  daemonWs.on("connection", (socket) => {
    daemonConnection = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.method !== "initialize") return;
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          protocolVersion: "0.153.2",
          serverInfo: { name: "test-daemon", userAgent: "test-daemon/0.153.2" },
          capabilities: { experimentalApi: true },
        },
      }));
    });
  });
  await new Promise((resolve, reject) => {
    daemonHttp.once("error", reject);
    daemonHttp.listen(daemonSocket, resolve);
  });

  const port = await reserveLocalPort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      CODEX_PWA_HOST: "127.0.0.1",
      CODEX_PWA_PORT: String(port),
      CODEX_PWA_ROOTS: root,
      CODEX_PWA_PASSWORD_FILE: "",
      CODEX_PWA_APP_SERVER_MODE: "shared-daemon",
      CODEX_PWA_DAEMON_SOCKET: daemonSocket,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  let firstReader = null;
  let secondReader = null;
  t.after(async () => {
    await firstReader?.cancel().catch(() => {});
    await secondReader?.cancel().catch(() => {});
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    daemonWs.close();
    await new Promise((resolve) => daemonHttp.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/`, child);
  for (let attempt = 0; attempt < 50 && !daemonConnection; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(daemonConnection, "the test daemon should receive the shared WebSocket connection");

  const readEvent = async (reader, pending = "") => {
    let buffer = pending;
    for (;;) {
      const separator = buffer.indexOf("\n\n");
      if (separator >= 0) {
        const frame = buffer.slice(0, separator);
        const rest = buffer.slice(separator + 2);
        const id = frame.match(/^id: (\d+)$/m)?.[1] || null;
        const data = frame.match(/^data: (.+)$/m)?.[1] || null;
        if (data) return { event: data ? JSON.parse(data) : null, id, rest };
        buffer = rest;
        continue;
      }
      const result = await reader.read();
      if (result.done) throw new Error("SSE stream ended before the expected event");
      buffer += new TextDecoder().decode(result.value, { stream: true });
    }
  };
  const emittedAtMs = Date.now() - 60_000;
  const sendNotification = (label) => daemonConnection.send(JSON.stringify({
    method: "thread/updated",
    emittedAtMs,
    params: { threadId: "thread-replay", label },
  }));

  let response = await fetch(`${base}/api/events`);
  assert.equal(response.status, 200);
  firstReader = response.body.getReader();
  let pending = "";
  let frame;
  do {
    frame = await readEvent(firstReader, pending);
    pending = frame.rest;
  } while (!frame.id);
  await sendNotification("在线事件");
  do {
    frame = await readEvent(firstReader, pending);
    pending = frame.rest;
  } while (frame.event?.kind !== "app-server/notification");
  const firstEventId = Number(frame.id);
  const receivedAt = frame.event.message.pwaReceivedAt;
  assert.equal(frame.event.message.emittedAtMs, emittedAtMs);
  assert.ok(receivedAt > 0 && receivedAt <= Date.now() / 1000);
  assert.ok(Number.isSafeInteger(firstEventId) && firstEventId > 0);
  await firstReader.cancel();

  await sendNotification("离线期间事件");
  response = await fetch(`${base}/api/events?after=${firstEventId}`);
  assert.equal(response.status, 200);
  secondReader = response.body.getReader();
  pending = "";
  do {
    frame = await readEvent(secondReader, pending);
    pending = frame.rest;
  } while (frame.event?.kind !== "app-server/notification");
  assert.equal(frame.event.message.params.label, "离线期间事件");
  assert.ok(Number(frame.id) > firstEventId);
  const offlineReceivedAt = frame.event.message.pwaReceivedAt;
  assert.equal(frame.event.message.emittedAtMs, emittedAtMs);
  assert.ok(offlineReceivedAt >= receivedAt);
  await secondReader.cancel();
  response = await fetch(`${base}/api/events?after=${firstEventId}`);
  secondReader = response.body.getReader();
  pending = "";
  do {
    frame = await readEvent(secondReader, pending);
    pending = frame.rest;
  } while (frame.event?.kind !== "app-server/notification");
  assert.equal(frame.event.message.pwaReceivedAt, offlineReceivedAt, "replay must not restamp receipt time");
  assert.equal(frame.event.message.emittedAtMs, emittedAtMs, "replay must preserve upstream emission time");
});

test("Web UI restart reconnects to the shared daemon without stopping it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-restart-test-"));
  const daemonSocket = join(root, "daemon.sock");
  const daemonHttp = createHttpServer();
  const daemonWs = new WebSocketServer({ server: daemonHttp });
  let connectionCount = 0;
  daemonWs.on("connection", (socket) => {
    connectionCount += 1;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.method !== "initialize") return;
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          protocolVersion: "0.153.2",
          serverInfo: { name: "restart-test-daemon", userAgent: "restart-test-daemon/0.153.2" },
          capabilities: { experimentalApi: true },
        },
      }));
    });
  });
  await new Promise((resolve, reject) => {
    daemonHttp.once("error", reject);
    daemonHttp.listen(daemonSocket, resolve);
  });

  const port = await reserveLocalPort();
  let child = null;
  const spawnWebUi = () => {
    const processHandle = spawn(process.execPath, ["server.mjs"], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        CODEX_PWA_HOST: "127.0.0.1",
        CODEX_PWA_PORT: String(port),
        CODEX_PWA_ROOTS: root,
        CODEX_PWA_PASSWORD_FILE: "",
        CODEX_PWA_APP_SERVER_MODE: "shared-daemon",
        CODEX_PWA_DAEMON_SOCKET: daemonSocket,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processHandle.stdout.resume();
    processHandle.stderr.resume();
    return processHandle;
  };
  const waitForReady = async (processHandle) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (processHandle.exitCode !== null) throw new Error(`Web UI exited with code ${processHandle.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.status === 200) return response.json();
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error("Timed out waiting for Web UI bridge readiness");
  };
  t.after(async () => {
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (child?.exitCode === null) await once(child, "exit");
    daemonWs.close();
    await new Promise((resolve) => daemonHttp.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  child = spawnWebUi();
  assert.deepEqual(await waitForReady(child), { ok: true, bridge: "ready", version: packageManifest.version });
  assert.equal(connectionCount, 1);
  assert.equal(daemonHttp.listening, true);
  child.kill("SIGTERM");
  await once(child, "exit");
  child = null;
  assert.equal(daemonHttp.listening, true);

  child = spawnWebUi();
  assert.deepEqual(await waitForReady(child), { ok: true, bridge: "ready", version: packageManifest.version });
  assert.equal(connectionCount, 2);
  assert.equal(daemonHttp.listening, true);
});

test("concurrent clients serialize same-thread turn writes through the real HTTP bridge", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-concurrent-write-test-"));
  const daemonSocket = join(root, "daemon.sock");
  const daemonHttp = createHttpServer();
  const daemonWs = new WebSocketServer({ server: daemonHttp });
  let daemonConnection = null;
  let activeTurnStarts = 0;
  let maxConcurrentTurnStarts = 0;
  const turnStartTimes = [];
  daemonWs.on("connection", (socket) => {
    daemonConnection = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.method === "initialize") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            protocolVersion: "0.153.2",
            serverInfo: { name: "concurrency-test-daemon", userAgent: "concurrency-test-daemon/0.153.2" },
            capabilities: { experimentalApi: true },
          },
        }));
        return;
      }
      if (message.method === "thread/read" || message.method === "thread/resume") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: "thread-concurrent",
              cwd: root,
              name: "并发写入测试",
              status: { type: "idle" },
            },
          },
        }));
        return;
      }
      if (message.method !== "turn/start") return;
      activeTurnStarts += 1;
      maxConcurrentTurnStarts = Math.max(maxConcurrentTurnStarts, activeTurnStarts);
      const startedAt = Date.now();
      const record = { startedAt, prompt: message.params?.input?.[0]?.text || "" };
      turnStartTimes.push(record);
      setTimeout(() => {
        activeTurnStarts -= 1;
        socket.send(JSON.stringify({
          id: message.id,
          result: { turn: { id: `turn-${turnStartTimes.length}`, status: "inProgress" } },
        }));
        record.completedAt = Date.now();
      }, 90);
    });
  });
  await new Promise((resolve, reject) => {
    daemonHttp.once("error", reject);
    daemonHttp.listen(daemonSocket, resolve);
  });

  const port = await reserveLocalPort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      CODEX_PWA_HOST: "127.0.0.1",
      CODEX_PWA_PORT: String(port),
      CODEX_PWA_ROOTS: root,
      CODEX_PWA_PASSWORD_FILE: "",
      CODEX_PWA_APP_SERVER_MODE: "shared-daemon",
      CODEX_PWA_DAEMON_SOCKET: daemonSocket,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    daemonWs.close();
    await new Promise((resolve) => daemonHttp.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/`, child);
  for (let attempt = 0; attempt < 50 && !daemonConnection; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(daemonConnection, "the test daemon should receive the shared WebSocket connection");

  const sendTurn = (prompt) => fetch(`${base}/api/threads/thread-concurrent/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const [first, second] = await Promise.all([sendTurn("来自手机的第一条消息"), sendTurn("来自电脑的第二条消息")]);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(turnStartTimes.length, 2);
  assert.equal(maxConcurrentTurnStarts, 1);
  assert.ok(turnStartTimes[1].startedAt >= turnStartTimes[0].completedAt);
  assert.deepEqual(turnStartTimes.map((item) => item.prompt), ["来自手机的第一条消息", "来自电脑的第二条消息"]);
});

test("directory picker exposes mobile browsing, filtering, and creation controls", async () => {
  const [server, fileApi, app, directoryBrowser, fileBrowser, html] = await Promise.all([
    readServerSources(),
    readProductSource("file-api.mjs"),
    readAppSources(),
    readProductSource("public/directory-browser.js"),
    readProductSource("public/file-browser.js"),
    readProductSource("public/index.html"),
  ]);
  for (const id of [
    "browseDirectoryButton", "directoryDialog", "directoryRoots", "directoryBreadcrumbs",
    "directorySearch", "showHiddenDirectories", "directoryCurrentPath", "directoryList",
    "newDirectoryForm", "newDirectoryInput", "showNewDirectoryButton", "chooseDirectoryButton",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(fileApi, /x-codex-pwa-directory/);
  assert.match(fileApi, /entry\.isDirectory\(\)/);
  assert.match(fileApi, /maxDirectoryEntries/);
  assert.match(fileApi, /sensitiveEntryName/);
  assert.match(fileApi, /sensitive: sensitiveEntryName\(entry\.name\)/);
  assert.match(directoryBrowser, /loadDirectory/);
  assert.match(app, /createDirectoryBrowserManager/);
  assert.match(fileBrowser, /敏感文件/);
  assert.match(directoryBrowser, /敏感目录/);
  assert.match(app, /codex-pwa-last-directory/);
});

test("streaming upload API is bounded, CSRF-marked, and atomically claims new names", async () => {
  const [server, fileApi, app, html, worker] = await Promise.all([
    readServerSources(),
    readProductSource("file-api.mjs"),
    readAppSources(),
    readProductSource("public/index.html"),
    readProductSource("public/sw.js"),
  ]);
  assert.match(fileApi, /Busboy/);
  assert.match(fileApi, /x-codex-pwa-upload/);
  assert.match(fileApi, /pipeline\(stream, meter, uploadWriteStreamFactory/);
  assert.match(fileApi, /await link\(tempPath, destination\)/);
  assert.match(fileApi, /maxUploadFileSize = 256 \* 1024 \* 1024/);
  assert.match(fileApi, /maxUploadBatchSize = 512 \* 1024 \* 1024/);
  assert.match(app, /XMLHttpRequest/);
  assert.match(worker, /"\/task-snapshot\.js"/);
  assert.match(app, /appendUploadedFileReferences/);
  for (const id of [
    "attachButton", "fileInput", "photoInput", "attachmentTray", "newAttachButton", "newFileInput",
    "newPhotoInput", "newAttachmentTray", "attachmentSourceDialog", "choosePhotoButton", "chooseFileButton",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /id="photoInput"[^>]*accept="image\/\*"[^>]*multiple/);
  assert.match(html, /id="newPhotoInput"[^>]*accept="image\/\*"[^>]*multiple/);
  assert.doesNotMatch(html, /id="(?:new)?[Pp]hotoInput"[^>]*\bcapture(?:=|\s|>)/);
  assert.match(app, /openAttachmentSource/);
  assert.match(app, /chooseAttachmentSource\("photo"\)/);
  assert.match(worker, /\/upload-utils\.js/);
});

test("V2 interface exposes the core mobile task controls", async () => {
  const html = await readProductSource("public/index.html");
  for (const id of [
    "searchTaskButton", "searchDialog", "searchTaskInput", "clearSearchTaskButton", "recentTab", "allHistoryTab", "archivedTab", "threadFilter", "contextPanel", "changesPanel", "newModelSelect",
    "settingsDialog", "renameDialog", "approvalArea", "scrollBottomButton", "historyControls",
    "loadMoreHistoryButton", "loadCompleteHistoryButton", "historyNodesButton", "releaseThreadButton",
    "attachButton", "fileInput", "photoInput", "attachmentTray", "newAttachButton", "newFileInput",
    "newPhotoInput", "newAttachmentTray", "attachmentSourceDialog", "choosePhotoButton", "chooseFileButton",
    "authGate", "loginForm", "rememberDevice", "changeCredentialsLoginButton", "logoutButton", "logoutAllButton", "refreshWebUiButton",
    "newPermissionSelect", "settingsPermissionSelect",
    "serverFilesButton", "fileBrowserDialog", "fileBrowserSearch", "showHiddenFiles",
    "trustedDevicesButton", "devicesDialog", "devicesList", "logoutOtherDevicesButton", "changeCredentialsButton",
    "credentialsDialog", "credentialsForm", "currentUsernameInput", "currentPasswordInput", "newUsernameInput", "newPasswordInput", "confirmNewPasswordInput",
    "threadActionDialog", "actionPinThreadButton", "actionRenameThreadButton", "actionCopyThreadIdButton", "actionArchiveThreadButton",
    "goalBar", "helpButton", "helpDialog", "askWebUiButton", "requestUiChangeButton",
    "historyNodesDialog", "historyNodesSearch", "historyNodesList", "historyNodesLoadMoreButton", "historyNodesLoadAllButton",
    "confirmDialog", "submitConfirmButton",
    "deviceRenameDialog", "deviceRenameForm",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test("primary conversation messages render compatible timestamps", async () => {
  const [app, messageView, css, timeDisplay] = await Promise.all([
    readAppSources(),
    readProductSource("public/message-view.js"),
    readProductSource("public/styles.css"),
    readProductSource("public/time-display.js"),
  ]);
  assert.match(timeDisplay, /export function normalizeEpochSeconds/);
  assert.match(app, /function messageTime\(/);
  assert.match(app, /resolveMessageTiming/);
  assert.match(app, /displayedMessageTime/);
  assert.match(messageView, /applyMessageTiming\(row, itemId, timing/);
  assert.match(messageView, /applyMessageTiming\(existing\.element, itemId, timing/);
  assert.match(messageView, /timestampEstimated: true/);
  assert.match(app, /observedAt: message\.pwaReceivedAt, browserAt: Date\.now\(\)/);
  // Message-level and fallback timestamps are verified through real renders
  // in the Chrome suite, independently of the turn reconciliation syntax.
  assert.match(app, /工作目录：\$\{basename\(cwd\)\}/);
  assert.doesNotMatch(app, /创建来源：\$\{sourceLabel\(state\.selectedThread\)\}/);
  assert.match(app, /elements\.chatMeta\.title = cwd \|\| "工作目录未知"/);
  assert.match(css, /\.message-meta\s*\{/);
  assert.match(css, /\.message-row\.user \.message-meta/);
  assert.match(app, /meta = el\("time", "message-meta"\)/);
  assert.match(app, /meta\.setAttribute\("datetime", meta\.dateTime\)/);
});

test("task list relative timestamps refresh while the page remains open", async () => {
  const [app, listView, timeDisplay] = await Promise.all([
    readAppSources(),
    readProductSource("public/thread-list-view.js"),
    readProductSource("public/time-display.js"),
  ]);
  assert.match(app, /function refreshRelativeTimes\(\)/);
  assert.match(app, /querySelectorAll\("\.thread-time\[data-epoch\]"\)/);
  assert.match(app, /time\.textContent = formatRelative\(epoch\)/);
  assert.match(app, /time\.title = formatAbsolute\(epoch\)/);
  assert.match(listView, /time\.dataset\.epoch = String\(activityAt\)/);
  assert.match(app, /setInterval\(refreshRelativeTimes, 30_000\)/);
  // Initial relative text is checked in Chrome; reused time nodes need not
  // receive their label in the element constructor.
  assert.match(listView, /time\.dateTime = new Date\(activityAt \* 1000\)\.toISOString\(\)/);
  assert.match(timeDisplay, /export function normalizeEpochSeconds/);
  assert.match(timeDisplay, /export function formatTimestampMs/);
  assert.equal(normalizeEpochSeconds(1_700_000_000_000), 1_700_000_000);
  assert.equal(normalizeEpochSeconds("bad"), 0);
  assert.equal(formatRelative(1_700_000_000, 1_700_000_030_000), "刚刚");
  assert.notEqual(formatAbsolute(1_700_000_000), "—");
  assert.notEqual(formatTimestampMs(1_700_000_000_000), "—");
});

test("idle task reopening restores a bounded view position while active output follows latest", async () => {
  const app = await readAppSources();
  assert.match(app, /threadViewState: readThreadViewState\(localStorage/);
  assert.match(app, /function rememberSelectedThreadView\(\)/);
  assert.match(app, /function restoreSelectedThreadView\(threadId\)/);
  assert.match(app, /!state\.activeTurnId && restoreSelectedThreadView\(thread\.id\)/);
  assert.match(app, /scheduleSelectedThreadViewSave\(\)/);
  assert.match(app, /thread-view-state\.js/);
});

test("bridge exposes thread organization and model APIs", async () => {
  const [source, bridge] = await Promise.all([
    readServerSources(),
    readFile(new URL("../app-server-bridge.mjs", import.meta.url), "utf8"),
  ]);
  for (const method of [
    "model/list", "thread/name/set", "thread/archive", "thread/unarchive",
    "thread/turns/list", "thread/unsubscribe", "thread/metadata/update",
    "thread/goal/get", "thread/goal/set", "thread/goal/clear",
  ]) {
    assert.match(source + bridge, new RegExp(method.replace("/", "\\/")));
  }
  assert.match(bridge, /experimentalApi:\s*true/);
  assert.match(source, /\/release/);
  assert.match(source, /getCodex\(\)\.recycle\(reason\)/);
  assert.match(source, /threadSource:\s*"codex-pwa-mobile"/);
});

test("bridge status records protocol versions and capability diagnostics", async () => {
  const [server, bridge, app] = await Promise.all([
    readServerSources(),
    readFile(new URL("../app-server-bridge.mjs", import.meta.url), "utf8"),
    readAppSources(),
  ]);
  assert.match(server, /protocol-adapter\.mjs/);
  assert.match(bridge, /const initializeResult = await this\.requestRaw\("initialize"/);
  assert.match(bridge, /this\.protocol = normalizeProtocolSnapshot\(initializeResult\)/);
  assert.match(server, /protocol: codex\.protocol/);
  assert.match(server, /eventReplay: sseReplay\.snapshot\(\)/);
  assert.match(app, /state\.eventReplay = status\.eventReplay/);
  assert.match(app, /state\.protocol = status\.protocol/);
  assert.match(app, /KNOWN_NOTIFICATION_METHODS/);
  assert.match(app, /state\.protocol\?\.advertisedCapabilities/);
  assert.match(app, /Codex 能力/);
  assert.match(app, /未识别通知/);
  assert.match(app, /未知通知/);
  assert.match(app, /notification-diagnostics\.js/);
  assert.match(app, /function unknownNotificationSummary\(\)/);
  assert.match(app, /formatAbsolute\(lastAt\)/);
  assert.match(app, /persistUnknownNotifications\(storage/);
});

test("status diagnostics expose broad file-root policy without changing authorization", async () => {
  const [server, app, access] = await Promise.all([
    readServerSources(),
    readAppSources(),
    readFile(new URL("../root-access.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(server, /rootAccessPolicy: rootAccess\.policy\(\)/);
  assert.match(access, /broad: this\.home \? this\.roots\.some\(\(root\) => root === this\.home\)/);
  assert.match(server, /rootAccessPolicy: rootAccess\.policy\(\)/);
  assert.match(server, /CODEX_PWA_ROOTS covers the entire user home/);
  assert.match(app, /state\.rootAccessPolicy = status\.rootAccessPolicy \|\| null/);
  assert.match(app, /整个用户 home/);
  assert.match(app, /用 CODEX_PWA_ROOTS 限定到项目目录/);
});

test("filesystem failures use safe actionable API messages", async () => {
  const [source, moduleSource] = await Promise.all([
    readServerSources(),
    readProductSource("error-utils.mjs"),
  ]);
  assert.match(source, /normalizeErrorStatus/);
  assert.match(moduleSource, /function publicErrorMessage\(error\)/);
  assert.match(moduleSource, /没有权限访问该路径；请检查目录权限或 CODEX_PWA_ROOTS 授权范围/);
  assert.match(moduleSource, /目标路径不存在，可能已被移动或删除/);
  assert.match(moduleSource, /服务器存储空间不足/);
  assert.match(moduleSource, /目标文件或文件夹已经存在/);
  assert.match(moduleSource, /文件操作无法完成；请检查路径是否存在且位于授权范围内/);
  assert.match(moduleSource, /error\?\.code === "EACCES"/);
  assert.equal(normalizeErrorStatus({ code: "EACCES" }), 403);
  assert.equal(normalizeErrorStatus({ code: "ENOSPC" }), 507);
  assert.equal(normalizeErrorStatus({ code: "EEXIST" }), 409);
  assert.equal(normalizeErrorStatus({ code: "ENOENT", path: "/srv/missing" }), 400);
  assert.equal(publicErrorMessage({ code: "ENOENT", path: "/srv/missing" }), "目标路径不存在，可能已被移动或删除");
  assert.equal(publicErrorMessage({ code: "EDQUOT", path: "/srv/private" }), "服务器存储空间不足；请清理磁盘或联系管理员后重试");
  assert.equal(publicErrorMessage({ code: "EUNKNOWN", path: "/srv/private" }), "文件操作无法完成；请检查路径是否存在且位于授权范围内");
});

test("multipart upload converts ENOSPC and EDQUOT into HTTP 507 and cleans temporary files", async (t) => {
  for (const code of ["ENOSPC", "EDQUOT"]) {
    await t.test(code, async () => {
      const root = await mkdtemp(join(tmpdir(), `codex-pwa-${code.toLowerCase()}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      const boundary = `----codex-pwa-${code.toLowerCase()}`;
      const body = Buffer.from([
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="files"; filename="failure.txt"\r\n`,
        "Content-Type: text/plain\r\n\r\n",
        "故障注入上传\r\n",
        `--${boundary}--\r\n`,
      ].join(""));
      const request = Readable.from(body);
      request.method = "POST";
      request.headers = {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
        "x-codex-pwa-upload": "1",
      };
      const response = {
        statusCode: null,
        body: "",
        writeHead(statusCode) { this.statusCode = statusCode; },
        end(body = "") { this.body = body; },
      };
      let injectedPath = null;
      const { handleFileApi } = createFileApi({
        roots: [root],
        isAllowedPath: (candidate) => candidate === root || candidate.startsWith(`${root}/`),
        resolveAllowedDirectory: async (candidate) => candidate === root ? root : (() => { throw new Error("unexpected directory"); })(),
        allowedThread: async () => { throw new Error("thread lookup is not used in this test"); },
        readBody: async () => ({}),
        sendJson: () => {},
        sensitiveEntryName: () => false,
        uploadWriteStreamFactory: (path) => {
          injectedPath = path;
          return new Writable({
            write(_chunk, _encoding, callback) {
              const error = new Error(`${code} simulated for ${path}`);
              error.code = code;
              error.path = path;
              callback(error);
            },
          });
        },
      });

      let failure;
      await assert.rejects(
        handleFileApi(request, response, new URL(`http://localhost/api/files/upload?cwd=${encodeURIComponent(root)}`)),
        (error) => {
          failure = error;
          response.writeHead(normalizeErrorStatus(error));
          response.end(JSON.stringify({ error: publicErrorMessage(error) }));
          return error.code === code;
        },
      );
      assert.ok(injectedPath);
      assert.equal(response.statusCode, 507);
      assert.deepEqual(JSON.parse(response.body), { error: "服务器存储空间不足；请清理磁盘或联系管理员后重试" });
      assert.equal(response.body.includes(injectedPath), false);
      assert.deepEqual(await readdir(root), []);
    });
  }
});

test("cross-client write conflicts have a stable API error and recovery path", async () => {
  const [server, app] = await Promise.all([
    readServerSources(),
    readAppSources(),
  ]);
  assert.match(server, /code: "THREAD_WRITE_CONFLICT"/);
  assert.match(server, /statusCode = 409/);
  assert.match(server, /active\\s\+writer/);
  assert.match(server, /function protocolWriterEvidence\(error\)/);
  assert.match(server, /threadWriteConflictError\(error, \{ threadId, turnId \}\)/);
  assert.match(app, /function isThreadWriteConflict\(error\)/);
  assert.match(app, /任务存在写入冲突，请确认两端连接同一个 Codex 服务/);
  assert.match(app, /关闭任务窗口不一定能解除占用/);
  assert.match(app, /refreshSelectedThread\(\{ preserveScroll: true \}\)/);
  assert.match(app, /clearThreadWriteConflict\(params\.threadId\)/);
  assert.match(app, /label: writeConflict \? uiText\("composer\.sendPrompt\.label"\) : uiText\("common\.retry"\)/);
  assert.match(app, /elements\.composer\.requestSubmit\(\)/);
});

test("same-task turn writes are serialized before reaching app-server", async () => {
  const source = await readServerSources();
  assert.match(source, /thread-mutation-queue\.mjs/);
  assert.match(source, /const threadMutationQueue = new ThreadMutationQueue\(\)/);
  assert.match(source, /const outcome = await threadMutationQueue\.run\(threadId, async \(\) => \{/);
  assert.match(source, /const result = await threadMutationQueue\.run\(threadId, async \(\) => \{/);
  assert.match(source, /queuedMutations: \[\.\.\.threadMutationQueue\.keys\(\)\]/);
  assert.match(source, /if \(threadId\) await threadMutationQueue\.run\(threadId, respond, mutationOptions\(\)\);/);
  assert.match(source, /codex\.respondToServerRequest\(requestId, \{ answers \}, pending\)/);
});

test("background task activity keeps a persisted unread marker", async () => {
  const [app, css, eventConnection] = await Promise.all([
    readAppSources(),
    readProductSource("public/styles.css"),
    readProductSource("public/event-connection.js"),
  ]);
  assert.match(app, /readStoredUnreadThreads\(\)/);
  assert.match(app, /localStorage\.setItem\(UNREAD_THREADS_STORAGE_KEY/);
  assert.match(app, /function markThreadUnread\(threadId\)/);
  assert.match(app, /function clearThreadUnread\(threadId\)/);
  assert.match(app, /method === "turn\/started" \|\| method === "turn\/completed"/);
  assert.match(eventConnection, /markThreadUnread\(requestThreadId\)/);
  assert.match(app, /clearThreadUnread\(threadId\)/);
  assert.match(css, /\.thread-unread-badge\s*\{/);
});

test("file browser exposes multi-select batch deletion with bounded paths", async () => {
  const [app, fileBrowser, html, css, fileApi] = await Promise.all([
    readAppSources(),
    readProductSource("public/file-browser.js"),
    readProductSource("public/index.html"),
    readProductSource("public/styles.css"),
    readProductSource("file-api.mjs"),
  ]);
  assert.match(html, /id="deleteSelectedFilesButton"/);
  assert.match(html, /id="copySelectedFilesButton"/);
  assert.match(html, /id="moveSelectedFilesButton"/);
  assert.match(html, /id="fileBrowserUploadStatus"/);
  assert.match(html, /id="pauseFileBrowserUploadButton"/);
  assert.match(fileBrowser, /fileBrowser\.selectedPaths/);
  assert.match(fileBrowser, /function deleteSelectedFileBrowserEntries\(\)/);
  assert.match(fileBrowser, /function operateSelectedFileBrowserEntries\(operation\)/);
  assert.match(fileBrowser, /function syncFileBrowserUploadProgress\(\)/);
  assert.match(fileBrowser, /function pauseBrowserDirectoryUpload\(\)/);
  assert.match(fileBrowser, /继续时将从头上传/);
  assert.match(fileBrowser, /state\.browserUploadSession/);
  assert.match(fileBrowser, /request\.upload\.addEventListener\("progress"/);
  assert.match(fileBrowser, /state\.uploadRequest\.abort\(\)/);
  assert.match(app, /state\.uploadContext !== "browser"\) state\.uploadRequest\?\.abort\(\)/);
  assert.match(fileBrowser, /paths: selectedPaths/);
  assert.match(fileBrowser, /file-entry-select/);
  assert.match(fileApi, /Array\.isArray\(body\.paths\)/);
  assert.match(fileApi, /批量操作只支持移动、复制或删除/);
  assert.match(fileApi, /最多选择 100 个项目/);
  assert.match(css, /\.file-entry-select/);
});

test("startup reconciles persisted active-task snapshots after a Web UI restart", async () => {
  const app = await readAppSources();
  assert.match(app, /ACTIVE_TASK_SNAPSHOT_STORAGE_KEY/);
  assert.match(app, /function readStoredActiveTaskSnapshot\(\)/);
  assert.match(app, /function syncActiveTaskSnapshot\(threads\)/);
  assert.match(app, /snapshotRecoveryMessage\(reconcileTaskSnapshot/);
  assert.doesNotMatch(app, /后台任务已完成/);
  assert.match(app, /syncActiveTaskSnapshot\(state\.threads\)/);
});

test("conversation output exposes accessible generation and outcome states", async () => {
  const [app, messageView, renderer, html, css, outline] = await Promise.all([
    readAppSources(),
    readProductSource("public/message-view.js"),
    readProductSource("public/markdown-renderer.js"),
    readProductSource("public/index.html"),
    readProductSource("public/styles.css"),
    readProductSource("public/message-outline.js"),
  ]);
  assert.match(app, /aria-busy/);
  assert.match(app, /function createTurnOutcome\(turn\)/);
  assert.match(app, /function directInputEvidence\(thread\)/);
  assert.match(app, /function bridgeOwnershipEvidence\(threadId\)/);
  assert.match(app, /function writerConflictEvidence\(thread\)/);
  assert.match(app, /app-server 最近报告其他写入者/);
  assert.match(app, /Codex 报告暂不可直接写入/);
  assert.match(app, /function retryTurnPrompt\(turn\)/);
  assert.match(messageView, /function ensureAssistantCopyAction\(node, text\)/);
  assert.match(app, /重试此消息/);
  assert.match(app, /继续此消息/);
  assert.match(app, /message-display\.js/);
  assert.match(messageView, /function renderAssistantBody\(body, text/);
  assert.match(app, /function clearOutcomeUnknown\(row\)/);
  assert.match(messageView, /clearOutcomeUnknown\(pendingNode\.element\)/);
  assert.match(app, /dataset\.outcomeUnknown = "true"/);
  assert.match(renderer, /message-outline\.js/);
  assert.match(outline, /message-outline-list/);
  assert.match(css, /\.message-outline\s*\{/);
  assert.match(messageView, /展开完整回复/);
  assert.match(app, /row\.setAttribute\("aria-label", role === "user"/);
  assert.match(html, /id="changesTab"[^>]*aria-controls="changesPanel"/);
  assert.match(html, /id="infoTab"[^>]*aria-controls="infoPanel"/);
  assert.doesNotMatch(html, /class="eyebrow" lang="en"/);
  assert.match(html, /id="confirmEyebrow"[^>]*>确认操作/);
  assert.match(app, /confirmEyebrow\.lang = .*"zh-CN"/);
  assert.match(css, /\.message-body\.long-reply-collapsed\s*\{/);
  assert.match(css, /\.long-reply-toggle\s*\{/);
  assert.match(css, /\.turn-resume\s*\{/);
  assert.match(css, /\.message-copy\s*\{/);
  assert.match(css, /\.turn-resume\s*\{[^}]*min-height:\s*36px/);
  assert.match(css, /\.message-copy\s*\{[^}]*min-height:\s*36px/);
  assert.match(css, /\.copy-code\s*\{[^}]*min-height:\s*36px/);
  for (const selector of ["thread-batch-actions button", "turn-retry", "diff-load-more", "goal-actions button", "directory-create button", "device-actions button"]) {
    assert.match(css, new RegExp(`\\.${selector.replaceAll(" ", "\\s+")}\\s*\\{[^}]*min-height:\\s*36px`));
  }
  for (const [dialog, title] of [
    ["newTaskDialog", "newTaskDialogTitle"], ["directoryDialog", "directoryDialogTitle"],
    ["fileBrowserDialog", "fileBrowserDialogTitle"], ["devicesDialog", "devicesDialogTitle"],
    ["credentialsDialog", "credentialsDialogTitle"], ["threadActionDialog", "threadActionTitle"],
    ["confirmDialog", "confirmTitle"], ["helpDialog", "helpDialogTitle"],
    ["historyNodesDialog", "historyNodesDialogTitle"], ["deviceRenameDialog", "deviceRenameDialogTitle"],
    ["renameDialog", "renameDialogTitle"],
    ["settingsDialog", "settingsDialogTitle"], ["goalDialog", "goalDialogTitle"],
    ["attachmentSourceDialog", "attachmentSourceDialogTitle"],
  ]) {
    assert.match(html, new RegExp(`<dialog id="${dialog}"[^>]*aria-labelledby="${title}"`));
  }
});

test("resuming an existing task preserves its recorded permissions", async () => {
  const source = await readServerSources();
  const metadataOnlyResume = [...source.matchAll(/codex\.request\("thread\/resume",\s*\{ threadId, excludeTurns: true \}\)/g)];
  const legacyResume = [...source.matchAll(/codex\.request\("thread\/resume",\s*\{ threadId \}\)/g)];
  assert.equal(metadataOnlyResume.length, 1);
  assert.equal(legacyResume.length, 1);
  assert.match(source, /const resumed = await subscribeThread\(threadId, allowed\)/);
  assert.doesNotMatch(source, /thread\/resume[\s\S]{0,180}(?:approvalPolicy|sandbox)/);
  assert.match(source, /thread\/resume[\s\S]{0,120}excludeTurns:\s*true/);
  assert.match(source, /-32602[\s\S]{0,120}excludeTurns\|unknown field/);
  assert.match(source, /IDLE_SUBSCRIPTION_LEASE_MS/);
  assert.match(source, /idle-subscription-lease/);
});

test("task reads retain recorded model settings without a live subscription", async () => {
  const source = await readServerSources();
  assert.match(source, /let settings = serializeThreadSettings\(thread\);/);
  assert.match(source, /settings = subscribed\.settings \|\| settings;/);
});

test("task list pagination and persisted pins use app-server metadata", async () => {
  const [server, app, html] = await Promise.all([
    readServerSources(),
    readAppSources(),
    readProductSource("public/index.html"),
  ]);
  assert.match(server, /thread\/list[\s\S]*cursor/);
  assert.match(server, /thread\/metadata\/update/);
  assert.match(server, /isPinned: Boolean\(thread\.isPinned\)/);
  assert.match(app, /threadCursor/);
  assert.match(app, /loadThreads\(\{ silent: true, append: true \}\)/);
  assert.match(html, /id="loadMoreThreadsButton"/);
});

test("long histories use summary-first loading with bounded on-demand activity details", async () => {
  const [server, app, historyNodes, html, css] = await Promise.all([
    readServerSources(),
    readAppSources(),
    readProductSource("public/history-nodes.js"),
    readProductSource("public/index.html"),
    readProductSource("public/styles.css"),
  ]);
  assert.match(server, /itemsView = "summary"/);
  assert.match(server, /HISTORY_ACTIVITY_LIMIT_PER_TURN = 40/);
  assert.match(server, /MAX_HISTORY_OUTPUT_CACHE_BYTES/);
  assert.match(server, /outputTruncated: true/);
  assert.match(server, /historyOutputMatch/);
  assert.match(server, /readActiveNarrative/);
  assert.match(server, /narrativeHistoryPage/);
  assert.match(app, /loadActivityDetails/);
  assert.match(app, /loadMoreHistory/);
  assert.match(app, /加载更多历史对话/);
  assert.match(app, /加载完整历史对话/);
  assert.match(app, /openHistoryNodes/);
  assert.match(historyNodes, /appendHistoryNodes/);
  assert.match(app, /mergeActiveTranscript/);
  assert.match(app, /toggleCommandOutput/);
  assert.match(app, /replaceItems: true/);
  assert.match(app, /MAX_RETAINED_HISTORY_TURNS = 2_500/);
  assert.match(app, /MAX_RETAINED_HISTORY_CHARS = 32 \* 1024 \* 1024/);
  assert.match(app, /MAX_RETAINED_HISTORY_NODES = 5_000/);
  assert.match(app, /markHistoryMemoryLimited/);
  assert.match(html, /id="loadMoreHistoryButton"/);
  assert.match(html, /id="loadMoreHistoryButton"[^>]*>加载更多历史对话/);
  assert.match(html, /id="loadCompleteHistoryButton"[^>]*>加载完整历史对话/);
  assert.match(html, /id="historyNodesButton"/);
  assert.match(html, /询问 Codex 在使用本 Web UI 过程中遇到的问题/);
  assert.match(html, /新建 Web UI 使用帮助对话/);
  assert.match(html, /提出 Web UI 改进建议/);
  assert.match(css, /\.history-controls\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.history-controls button\s*\{[^}]*min-width:\s*0[^}]*white-space:\s*normal/);
});

test("sidebar utility menu is a compact 3x3 layout with inline connection status", async () => {
  const [app, html, css, worker, notifications] = await Promise.all([
    readAppSources(),
    readProductSource("public/index.html"),
    readProductSource("public/styles.css"),
    readProductSource("public/sw.js"),
    readProductSource("public/browser-notifications.js"),
  ]);
  assert.match(html, /class="sidebar-menu-grid"/);
  assert.match(html, /服务器文件/);
  assert.match(html, /深\/浅色模式/);
  assert.match(html, /使用帮助/);
  assert.match(html, /已登录设备管理/);
  assert.match(html, /退出当前设备/);
  assert.match(html, /刷新 Web UI/);
  assert.match(html, /id="notificationButton"/);
  assert.match(html, /id="notificationLabel"/);
  assert.match(html, /class="server-status-copy"/);
  assert.match(html, /id="networkLabel"/);
  assert.doesNotMatch(html, /id="fileBrowserBreadcrumbs"/);
  assert.doesNotMatch(app, /renderFileBrowserBreadcrumbs/);
  assert.match(html, /id="logoutAllButton"[^>]*>退出全部设备/);
  assert.match(css, /\.sidebar-menu-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3/);
  assert.match(css, /grid-template-areas:\s*"files theme notification"\s*"help devices refresh"\s*"logout status network"/);
  // Chrome checks consistent action typography and 200% font scaling without
  // requiring fixed pixel font declarations.
  assert.match(css, /\.sidebar-menu-grid \.sidebar-utility > span:first-child\s*\{[^}]*flex:\s*0 0 16px/);
  assert.match(css, /\.server-status-copy\s*\{[^}]*text-align:\s*left/);
  assert.match(css, /\.network-status\s*\{[^}]*align-items:\s*flex-start/);
  assert.match(css, /#networkLabel\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/);
  assert.match(app, /elements\.networkName\.textContent/);
  assert.match(css, /\.directory-current code\s*\{[^}]*direction:\s*rtl[^}]*text-align:\s*left/);
  assert.match(app, /refreshWebUiButton\.addEventListener/);
  assert.match(app, /registration\.waiting\.postMessage\(\{ type: "SKIP_WAITING" \}\)/);
  assert.match(app, /function browserNotificationsAvailable\(\)/);
  assert.match(app, /function enableBrowserNotifications\(\)/);
  assert.match(app, /function sendBrowserNotification\(/);
  assert.match(notifications, /Notification\.requestPermission/);
  assert.match(notifications, /isSecureContext/);
  assert.match(app, /notificationButton\.addEventListener\("click", enableBrowserNotifications\)/);
  assert.match(worker, /"\/browser-notifications\.js"/);
  assert.match(worker, /codex-pwa-v122/);
});

test("conversation list separates recent, all-history, and archived sessions", async () => {
  const [app, listView, threadList, html, css] = await Promise.all([
    readAppSources(),
    readProductSource("public/thread-list-view.js"),
    readProductSource("public/thread-list.js"),
    readProductSource("public/index.html"),
    readProductSource("public/styles.css"),
  ]);
  assert.match(html, /id="recentTab"[^>]*>近7天任务/);
  assert.match(html, /id="allHistoryTab"[^>]*>全部历史任务/);
  assert.match(html, /id="archivedTab"[^>]*>已归档任务/);
  assert.match(html, /id="threadFilter"/);
  assert.match(html, /id="threadProjectFilter"/);
  assert.match(app, /threadListMode:\s*"recent"/);
  assert.match(app, /threadFilter:\s*"all"/);
  assert.match(listView, /matchesThreadFilter\(thread, \{/);
  assert.match(app, /function setThreadFilter\(filter\)/);
  assert.match(app, /threadProjectFilter/);
  assert.match(listView, /function syncProjectFilterOptions\(\)/);
  assert.match(app, /function setThreadProjectFilter\(project\)/);
  assert.match(threadList, /RECENT_THREAD_WINDOW_SECONDS = 7 \* 24 \* 60 \* 60/);
  assert.match(threadList, /export function matchesThreadFilter/);
  assert.match(app, /isRecentThread/);
  assert.match(listView, /mode === "all"/);
  assert.match(listView, /state\.threadListMode === "archived"/);
  assert.match(app, /page\.some\(\(thread\) => !isRecentThread\(thread\)\)/);
  assert.match(css, /\.list-tab\s*\{[^}]*flex:\s*1 1 0/);
});

test("task inbox supports bounded batch selection, read state, and archive actions", async () => {
  const [app, listView, actions, html, css] = await Promise.all([
    readAppSources(),
    readProductSource("public/thread-list-view.js"),
    readProductSource("public/thread-actions.js"),
    readProductSource("public/index.html"),
    readProductSource("public/styles.css"),
  ]);
  for (const id of [
    "threadBatchActions", "selectVisibleThreadsButton", "markSelectedThreadsReadButton",
    "archiveSelectedThreadsButton", "clearSelectedThreadsButton",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(app, /selectedThreadIds: new Set\(\)/);
  assert.match(listView, /function visibleThreadCandidates\(\)/);
  assert.match(app, /createThreadActionsManager/);
  assert.match(actions, /createThreadActionsManager/);
  assert.match(actions, /async function markSelectedThreadsRead\(\)/);
  assert.match(actions, /async function archiveSelectedThreads\(\)/);
  assert.match(actions, /function openRenameDialog\(/);
  assert.match(actions, /function openThreadActionMenu\(/);
  assert.match(listView, /thread-select/);
  assert.match(actions, /restoring \? "unarchive" : "archive"/);
  assert.match(css, /\.thread-batch-actions\s*\{/);
  assert.match(css, /\.thread-select\s*\{/);
  assert.doesNotMatch(html, /id="threadTagFilter"/);
  assert.doesNotMatch(html, /id="tagDialog"/);
  assert.doesNotMatch(app, /THREAD_TAGS_STORAGE_KEY/);
  assert.doesNotMatch(app, /thread-tags\.js/);
  assert.doesNotMatch(app, /readStoredThreadTags\(localStorage\)/);
  assert.doesNotMatch(listView, /function syncTagFilterOptions\(/);
  assert.doesNotMatch(app, /function openTagDialog\(/);
  assert.doesNotMatch(css, /\.thread-tag\s*\{/);
});

test("selected task archive state is independent from the sidebar list mode", async () => {
  const [app, listView] = await Promise.all([
    readAppSources(),
    readProductSource("public/thread-list-view.js"),
  ]);
  assert.doesNotMatch(app, /state\.archived/);
  assert.match(listView, /thread\.archived \? uiText\("common\.restore"\) : uiText\("common\.archive"\)/);
  assert.equal(uiText("common.restore"), "恢复");
  assert.equal(uiText("common.archive"), "归档");
  assert.match(app, /if \(!state\.selectedThread\.archived\) params\.set\("subscribe", "true"\)/);
  assert.match(app, /routeThreadArchived/);
});

test("live output, server caches, and uncertain writes have explicit safety bounds", async () => {
  const [server, bridge, fileApi, app] = await Promise.all([
    readServerSources(),
    readFile(new URL("../app-server-bridge.mjs", import.meta.url), "utf8"),
    readProductSource("file-api.mjs"),
    readAppSources(),
  ]);
  assert.match(server, /MAX_HISTORY_OUTPUT_ENTRY_BYTES/);
  assert.match(bridge, /RPC_OUTCOME_UNKNOWN/);
  assert.match(bridge, /rpcMutationTimeoutMs/);
  assert.match(server, /MAX_ORIGINATOR_CACHE_ENTRIES/);
  assert.match(server, /MAX_ARTIFACT_INDEX_CACHE_ENTRIES/);
  assert.match(server, /MAX_LIVE_ARTIFACT_CACHE_BYTES = 96 \* 1024 \* 1024/);
  assert.match(server, /liveArtifactCacheBytes/);
  assert.match(fileApi, /copyToFinalPath/);
  assert.match(fileApi, /error\.code !== "EXDEV"/);
  assert.match(app, /MAX_LIVE_COMMAND_CHARS/);
  assert.match(app, /appendBoundedLiveText/);
  assert.match(app, /if \(error\.outcomeUnknown && rendered\)/);
  assert.match(app, /reconcileUnknownTaskStart/);
});

test("history node failures remain distinguishable from confirmed empty history", async () => {
  const historyNodes = await readProductSource("public/history-nodes.js");
  assert.match(historyNodes, /error:\s*""/);
  assert.match(historyNodes, /历史节点加载失败/);
  assert.match(historyNodes, /canRetryInitialLoad/);
});

test("menu transitions close open popovers before switching or replacing views", async () => {
  const [app, fileBrowser, deviceManager, actions] = await Promise.all([
    readAppSources(),
    readProductSource("public/file-browser.js"),
    readProductSource("public/device-manager.js"),
    readProductSource("public/thread-actions.js"),
  ]);
  assert.match(app, /function closeOpenMenus\(event\)[\s\S]*target\.closest\("\.floating-popover"\)[\s\S]*closeFloatingMenu\(\)/);
  assert.match(app, /document\.addEventListener\("pointerdown", closeOpenMenus, true\)/);
  // Chrome checks dismissal on the owning list's scroll and preservation
  // during unrelated background conversation scrolls.
  assert.match(app, /document\.addEventListener\("touchmove", closeAllMenus/);
  assert.match(app, /function openFloatingMenu\(anchor, owner, actions\)/);
  assert.match(app, /function closeSidebar\(\)[\s\S]*closeAllMenus\(\)/);
  assert.match(app, /function setListMode\(mode\)[\s\S]*closeAllMenus\(\)/);
  assert.match(app, /async function loadThreads\([\s\S]*const sequence = \+\+state\.threadLoadSequence;\n  if \(!silent \|\| append\) closeAllMenus\(\)/);
  assert.match(actions, /function openThreadActionMenu\(thread\)[\s\S]*closeAllMenus\(\)/);
  assert.match(fileBrowser, /function openFileBrowser\([\s\S]*closeAllMenus\(\)/);
  assert.match(app, /createDeviceManager/);
  assert.match(deviceManager, /async function openDevices\([\s\S]*closeAllMenus\(\)/);
  assert.match(app, /function openHelp\([\s\S]*closeAllMenus\(\)/);
});

test("mobile task settings are bilingual, per-task, and committed only after turn start succeeds", async () => {
  const [server, app, settings, html] = await Promise.all([
    readServerSources(),
    readAppSources(),
    readProductSource("public/task-settings.js"),
    readProductSource("public/index.html"),
  ]);
  assert.match(app, /threadSettings:\s*new Map/);
  assert.match(app, /createTaskSettingsManager/);
  assert.match(settings, /轻度（low）/);
  assert.match(settings, /极高（xhigh）/);
  assert.match(settings, /极致（ultra）/);
  assert.match(settings, /commitEffectiveSettings/);
  assert.match(app, /settings:\s*pendingSettings\(threadId\)/);
  assert.match(app, /commitEffectiveSettings\(threadId, result\.settings\)/);
  assert.match(server, /parseSettingsOverrides\(body\.settings, currentSettings\)/);
  assert.match(server, /const effectiveSettings = mergeThreadSettings\(currentSettings, overrides\.applied\)/);
  assert.match(server, /settings:\s*effectiveSettings/);
  assert.match(html, /请求批准/);
  assert.match(html, /帮我批准/);
  assert.match(html, /完全批准/);
});

test("browser authentication uses trusted-device cookies and CSRF without native Basic prompts", async () => {
  const [server, auth, app, deviceManager, html, worker] = await Promise.all([
    readServerSources(),
    readFile(new URL("../auth-api.mjs", import.meta.url), "utf8"),
    readAppSources(),
    readProductSource("public/device-manager.js"),
    readProductSource("public/index.html"),
    readProductSource("public/sw.js"),
  ]);
  assert.match(auth, /\/api\/auth\/login/);
  assert.match(auth, /\/api\/auth\/credentials\/change/);
  assert.match(auth, /\/api\/auth\/logout-all/);
  assert.match(auth, /x-codex-pwa-csrf/);
  assert.doesNotMatch(server, /www-authenticate/);
  assert.match(app, /X-Codex-PWA-CSRF/);
  assert.match(app, /\/api\/auth\/session/);
  assert.match(deviceManager, /\/api\/auth\/credentials\/change/);
  assert.match(app, /!state\.auth\.authenticated \|\| document\.visibilityState === "hidden"/);
  assert.match(auth, /globalLoginRateLimiter/);
  assert.match(auth, /loginRateLimitKey/);
  assert.match(html, /记住此设备 90 天/);
  assert.match(html, /修改用户名或密码/);
  assert.match(worker, /pathname\.startsWith\("\/api\/"\)/);
});

test("mobile client preserves drafts, routes tasks, throttles streams, and previews images", async () => {
  const [app, css, worker, html, manifest] = await Promise.all([
    readAppSources(),
    readProductSource("public/styles.css"),
    readProductSource("public/sw.js"),
    readProductSource("public/index.html"),
    readProductSource("public/manifest.webmanifest"),
  ]);
  assert.match(app, /codex-pwa-draft:/);
  assert.match(app, /pushState/);
  assert.match(app, /popstate/);
  assert.match(app, /STREAM_RENDER_INTERVAL_MS/);
  assert.match(app, /mergeTurnsPage/);
  assert.match(app, /URL\.createObjectURL\(file\)/);
  assert.match(css, /\.send-button\s*\{[^}]*width:\s*42px[^}]*height:\s*42px/s);
  assert.match(css, /\.attachment-thumbnail/);
  assert.match(app, /visualViewport/);
  assert.match(app, /--app-height/);
  assert.match(app, /window\.scrollTo\(0, 0\)/);
  assert.match(css, /\.composer textarea\s*\{[^}]*min-height:\s*58px/s);
  assert.match(html, /mobile-web-app-capable/);
  assert.match(html, /icon-192\.png\?v=27/);
  assert.match(manifest, /"purpose": "any"/);
  assert.match(worker, /SKIP_WAITING/);
  assert.doesNotMatch(worker, /install[\s\S]{0,180}skipWaiting/);
});

test("critical client actions require explicit confirmation and stop control lives by send", async () => {
  const [app, fileBrowser, approvalActions, goalActions, html, css, policy] = await Promise.all([
    readAppSources(),
    readProductSource("public/file-browser.js"),
    readProductSource("public/approval-actions.js"),
    readProductSource("public/goal-actions.js"),
    readProductSource("public/index.html"),
    readProductSource("public/styles.css"),
    readProductSource("public/approval-policy.js"),
  ]);
  assert.match(html, /class="composer-submit-actions"[\s\S]*id="stopButton"[\s\S]*id="sendButton"/);
  assert.match(app, /async function sendPrompt[\s\S]*requestConfirmation/);
  assert.match(app, /async function createTask[\s\S]*requestConfirmation/);
  assert.match(app, /async function stopTurn[\s\S]*requestConfirmation/);
  assert.match(goalActions, /async function saveGoal[\s\S]*requestConfirmation/);
  assert.match(app, /createApprovalActionsManager/);
  assert.match(approvalActions, /await requestConfirmation\(confirmation\)/);
  assert.match(app, /function approvalContext\(approval\)/);
  assert.match(app, /approval-policy\.js/);
  assert.match(app, /approval-context/);
  assert.match(policy, /高风险操作/);
  assert.match(policy, /可能覆盖或删除/);
  assert.match(policy, /overwrite\|truncate\|replace/);
  assert.match(css, /\.approval-context\s*\{/);
  assert.match(goalActions, /async function saveGoal[\s\S]*requestConfirmation/);
  assert.match(fileBrowser, /async function uploadFilesToBrowserDirectory[\s\S]*requestConfirmation/);
  assert.match(fileBrowser, /eyebrow: uiText\("common\.rename"\)/);
  assert.match(css, /\.composer-submit-actions\s*\{/);
});

test("context compaction and warning notices are rendered in the owning turn", async () => {
  const [app, activityView, css] = await Promise.all([
    readAppSources(),
    readProductSource("public/activity-view.js"),
    readProductSource("public/styles.css"),
  ]);
  assert.match(app, /item\.type === "ContextCompaction"/);
  assert.match(activityView, /function renderTurnNotice[\s\S]*turnGroup\(turnId, \{ create: Boolean\(turnId\) \}\)/);
  assert.match(app, /const turnId = notificationTurnId\(params\);[\s\S]*renderTurnNotice\(messageText/);
  assert.doesNotMatch(app, /elements\.messages\.append\(el\("div", "turn-error", messageText\)\)/);
  assert.match(css, /\.turn-notice\s*\{/);
});

test("shared-daemon mode uses the Unix WebSocket without recycling the daemon", async () => {
  const [source, bridge] = await Promise.all([
    readServerSources(),
    readFile(new URL("../app-server-bridge.mjs", import.meta.url), "utf8"),
  ]);
  const unit = await readFile(new URL("../systemd/codex-pwa.service", import.meta.url), "utf8");
  const installer = await readFile(new URL("../scripts/install-user.sh", import.meta.url), "utf8");
  assert.match(source, /CODEX_PWA_APP_SERVER_MODE/);
  assert.match(source, /createCodexAppServer\(/);
  assert.match(bridge, /createConnection\(\{ path: daemonSocket \}\)/);
  assert.match(bridge, /perMessageDeflate:\s*false/);
  assert.match(bridge, /sharedDaemonHeartbeatMs/);
  assert.match(bridge, /socket\.ping\(\)/);
  assert.match(bridge, /scheduleSharedReconnect/);
  assert.match(bridge, /subscribedThreads/);
  assert.match(bridge, /rpcOverloadRetryLimit/);
  assert.match(bridge, /error\?\.details\?\.code === -32001/);
  assert.match(source, /if \(usesSharedDaemon\) return false/);
  assert.match(unit, /EnvironmentFile=%h\/\.config\/codex-pwa\/codex-pwa\.env/);
  assert.match(unit, /MemoryHigh=768M/);
  assert.match(unit, /MemoryMax=1G/);
  assert.match(installer, /CODEX_PWA_APP_SERVER_MODE/);
  assert.match(installer, /app-server daemon bootstrap/);
  assert.match(installer, /app-server daemon start/);
  assert.match(installer, /CODEX_PWA_DAEMON_SOCKET/);
  assert.match(installer, /covers the entire user home/);
  assert.match(installer, /Prefer --root \/absolute\/project\/path/);
  assert.match(installer, /root_dir=\"\$app_dir\"/);
  assert.match(installer, /default: this PWA checkout/);
  assert.match(installer, /Security note/);
  assert.match(installer, /existing_configured_port/);
  assert.match(installer, /stop codex-pwa-private\.socket[\s\S]*stop codex-pwa-private\.service[\s\S]*restart codex-pwa\.service[\s\S]*start codex-pwa-private\.socket/);
});

test("per-user installer generates isolated roots, daemon socket, port, and private-network units", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex pwa installer test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const child = spawn("bash", [
    "scripts/install-user.sh",
    "--dry-run",
    "--yes",
    "--port", "4266",
    "--private-ip", "172.16.2.99",
    "--root", home,
    "--instance-name", "researcher 的 Codex",
  ], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      HOME: home,
      USER: "researcher",
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_PWA_SETUP_DRY_RUN: "1",
      CODEX_BIN: "/usr/local/bin/codex",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, errors);
  assert.match(output, /http:\/\/172\.16\.2\.99:4266/);
  assert.match(output, /sudo ufw allow in on oray_vnc/);

  const config = await readFile(join(home, ".config", "codex-pwa", "codex-pwa.env"), "utf8");
  assert.match(config, new RegExp(`CODEX_PWA_ROOTS="${home.replaceAll("/", "\\/")}"`));
  assert.match(config, /CODEX_PWA_PORT="4266"/);
  assert.match(config, new RegExp(`CODEX_HOME="${home.replaceAll("/", "\\/")}\\/.codex"`));
  assert.match(config, /CODEX_PWA_APP_SERVER_MODE="shared-daemon"/);
  assert.match(config, /CODEX_PWA_USERNAME_FILE=/);
  assert.match(config, /CODEX_PWA_INSTANCE_NAME="researcher 的 Codex"/);
  assert.match(config, /CODEX_PWA_PRIVATE_IP="172\.16\.2\.99"/);
  assert.match(config, /CODEX_PWA_LOOPBACK_ONLY="0"/);
  assert.doesNotMatch(config, /home\/dell/);

  const unitRoot = join(home, ".config", "systemd", "user");
  const [service, socket, proxy] = await Promise.all([
    readFile(join(unitRoot, "codex-pwa.service"), "utf8"),
    readFile(join(unitRoot, "codex-pwa-private.socket"), "utf8"),
    readFile(join(unitRoot, "codex-pwa-private.service"), "utf8"),
  ]);
  assert.ok(service.includes(`WorkingDirectory=${projectDirectory}\n`));
  assert.ok(service.includes(`EnvironmentFile=${join(home, ".config", "codex-pwa", "codex-pwa.env")}\n`));
  assert.doesNotMatch(service, /^WorkingDirectory=["']/m);
  assert.doesNotMatch(service, /^EnvironmentFile=["']/m);
  assert.match(service, /MemoryHigh=768M/);
  assert.match(service, /MemoryMax=1G/);
  assert.match(socket, /ListenStream=172\.16\.2\.99:4266/);
  assert.match(socket, /FreeBind=true/);
  assert.match(proxy, /127\.0\.0\.1:4266/);
  assert.equal((await stat(join(home, ".config", "codex-pwa", "access-password"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, ".config", "codex-pwa", "access-username"))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(home, ".config", "codex-pwa", "access-username"), "utf8")).trim(), "codex");

  const reinstall = spawn("bash", ["scripts/install-user.sh", "--dry-run", "--yes"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      HOME: home,
      USER: "researcher",
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_PWA_SETUP_DRY_RUN: "1",
      CODEX_BIN: "/usr/local/bin/codex",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let reinstallErrors = "";
  reinstall.stderr.on("data", (chunk) => { reinstallErrors += chunk; });
  const [reinstallCode] = await once(reinstall, "exit");
  assert.equal(reinstallCode, 0, reinstallErrors);
  const preserved = await readFile(join(home, ".config", "codex-pwa", "codex-pwa.env"), "utf8");
  assert.match(preserved, new RegExp(`CODEX_PWA_ROOTS="${home.replaceAll("/", "\\/")}"`));
  assert.match(preserved, /CODEX_PWA_PORT="4266"/);
  assert.match(preserved, /CODEX_PWA_INSTANCE_NAME="researcher 的 Codex"/);
  assert.match(preserved, /CODEX_PWA_PRIVATE_IP="172\.16\.2\.99"/);
  t.diagnostic("installer dry-run generated an isolated per-user deployment");
});

test("fresh installer defaults file access to the PWA checkout", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-pwa-fresh-installer-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const child = spawn("bash", ["scripts/install-user.sh", "--dry-run", "--yes"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      HOME: home,
      USER: "fresh-user",
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_PWA_SETUP_DRY_RUN: "1",
      CODEX_BIN: "/usr/local/bin/codex",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, errors);
  const config = await readFile(join(home, ".config", "codex-pwa", "codex-pwa.env"), "utf8");
  assert.match(config, new RegExp(`CODEX_PWA_ROOTS="${projectDirectory.replaceAll("/", "\\/")}"`));
  assert.doesNotMatch(config, new RegExp(`CODEX_PWA_ROOTS="${home.replaceAll("/", "\\/")}"`));
});

test("opening a task subscribes to live events and recovers missed output", async () => {
  const [server, sse, eventConnection] = await Promise.all([
    readServerSources(),
    readFile(new URL("../sse-events.mjs", import.meta.url), "utf8"),
    readProductSource("public/event-connection.js"),
  ]);
  const client = await readAppSources();
  assert.match(server, /url\.searchParams\.get\("subscribe"\) === "true"/);
  assert.match(server, /subscribeThread\(threadId, thread\)/);
  assert.match(server, /syncActiveTurnFromHistory\(threadId, history, thread\.status\)/);
  assert.match(client, /params\.set\("subscribe", "true"\)/);
  assert.match(client, /recoverVisibleState/);
  assert.match(client, /visibleRecoveryPromise/);
  // Browser regression covers failed state reads and automatic recovery;
  // coordinator tests cover callbacks from superseded connections.
  assert.match(client, /const pendingApprovals = new Map[\s\S]*state\.approvals = pendingApprovals/);
  assert.match(client, /approvalRevision === state\.approvalRevision/);
  assert.match(client, /sequence !== state\.openThreadSequence \|\| state\.selectedThread\?\.id !== threadId/);
  // Selected/background notification routing is exercised by the browser test;
  // hidden selected tasks must also receive completion and approval reminders.
  assert.match(client, /historyRetainedChars/);
  assert.match(client, /historyTurnChars/);
  assert.match(client, /canRetainHistoryPage\(\[result\.turn\]\)/);
  assert.match(eventConnection, /events\.onopen[\s\S]*recover\(\)/);
  assert.match(server, /EventReplayBuffer/);
  assert.match(server, /replay\.after\(afterEventId\)/);
  assert.match(server, /kind: "bridge\/heartbeat"/);
  assert.match(eventConnection, /eventLastHeartbeatAt/);
  assert.match(eventConnection, /now\(\) - state\.eventLastHeartbeatAt <= 60_000/);
  assert.match(eventConnection, /payload\.kind === "bridge\/heartbeat"/);
  assert.match(sse, /replay\.append\(payload\)/);
  assert.match(server, /url\.searchParams\.get\("after"\)/);
  assert.match(server, /kind: "bridge\/replayGap"/);
  assert.match(eventConnection, /lastEventId/);
  assert.match(eventConnection, /eventDeduper/);
  assert.match(eventConnection, /kind === "bridge\/replayGap"/);
  assert.match(eventConnection, /eventRecoveryCount/);
  assert.match(eventConnection, /网络已恢复/);
  assert.match(eventConnection, /部分实时更新已超出回放窗口/);
});

test("slow SSE clients are bounded and allowed to reconnect", async () => {
  const [server, sse, auth] = await Promise.all([
    readServerSources(),
    readFile(new URL("../sse-events.mjs", import.meta.url), "utf8"),
    readFile(new URL("../auth-api.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(server, /MAX_SSE_QUEUE_BYTES/);
  assert.match(sse, /queueFrame/);
  assert.match(sse, /flushClient/);
  assert.match(sse, /closeClient\(response, \{ destroy: true \}\)/);
  assert.match(auth, /for \(const client of \[\.\.\.sseClients\.keys\(\)\]\) closeSseClient\(client\)/);
});

test("generated images, server files, trusted devices, and long-press task actions are wired end to end", async () => {
  const [server, auth, fileApi, app, activityView, fileBrowser, deviceManager, accessRoots, listView, html, css] = await Promise.all([
    readServerSources(),
    readFile(new URL("../auth-api.mjs", import.meta.url), "utf8"),
    readProductSource("file-api.mjs"),
    readAppSources(),
    readProductSource("public/activity-view.js"),
    readProductSource("public/file-browser.js"),
    readProductSource("public/device-manager.js"),
    readProductSource("public/access-roots.js"),
    readProductSource("public/thread-list-view.js"),
    readProductSource("public/index.html"),
    readProductSource("public/styles.css"),
  ]);
  assert.match(fileApi, /\/api\/files\/list/);
  assert.match(fileApi, /\/api\/files\/search/);
  assert.match(fileApi, /搜索词至少需要 2 个字符/);
  assert.match(server, /\/api\/access-roots/);
  assert.match(auth, /\/api\/auth\/devices/);
  assert.match(auth, /\/api\/auth\/logout-others/);
  assert.match(server, /threadArtifactsMatch/);
  assert.match(server, /sanitizeNotificationForBrowser/);
  assert.match(activityView, /renderImageGeneration/);
  assert.match(app, /loadThreadArtifacts/);
  assert.match(activityView, /const group = turnGroup\(turnId\)/);
  assert.doesNotMatch(app, /turnGroup\(artifact\.turnId\) \|\| groups\.at\(-1\)/);
  assert.match(fileBrowser, /loadFileBrowser/);
  assert.match(app, /fileBrowserSearchAll/);
  assert.match(fileBrowser, /\/api\/files\/search/);
  assert.match(app, /openAccessRoots/);
  assert.match(app, /createDeviceManager/);
  assert.match(deviceManager, /renderDevices/);
  assert.match(deviceManager, /\/api\/auth\/devices/);
  assert.match(app, /createAccessRootsManager/);
  assert.match(accessRoots, /createAccessRootsManager/);
  assert.match(accessRoots, /X-Codex-PWA-Root-Change/);
  assert.match(accessRoots, /renderAccessRoots/);
  assert.match(listView, /pointerdown[\s\S]*setTimeout[\s\S]*520/);
  assert.match(listView, /contextmenu/);
  assert.match(html, /服务器文件/);
  assert.match(html, /id="fileBrowserSearchAll"/);
  assert.match(html, /id="accessRootsDialog"/);
  assert.match(html, /可信设备/);
  assert.match(css, /\.artifact-card/);
  assert.match(css, /\.file-entry/);
  assert.match(css, /\.file-entry-menu/);
  assert.match(css, /\.file-browser > \.directory-heading\s*\{[^}]*border-bottom:\s*0/);
  assert.match(css, /\.file-browser-roots[^}]*display:\s*none/);
  assert.match(css, /\.device-card/);
  assert.match(css, /\.thread-main[^}]*touch-action:\s*pan-y/s);
});

test("Goal state, confirmation actions, and top-level task menus are wired", async () => {
  const [server, app, goalActions, historyNodes, html, css, worker] = await Promise.all([
    readServerSources(),
    readAppSources(),
    readProductSource("public/goal-actions.js"),
    readProductSource("public/history-nodes.js"),
    readProductSource("public/index.html"),
    readProductSource("public/styles.css"),
    readProductSource("public/sw.js"),
  ]);
  assert.match(server, /goalSupported/);
  assert.match(server, /GOAL_STATUSES/);
  assert.match(server, /goalSetParams/);
  assert.match(server, /requestThreadGoalBestEffort/);
  assert.match(server, /uiText\("goals\.objectiveTooLong", MAX_GOAL_OBJECTIVE_LENGTH\)/);
  assert.match(app, /thread\/goal\/updated/);
  assert.match(app, /thread\/goal\/cleared/);
  assert.match(app, /requestConfirmation/);
  assert.match(app, /copyThreadId/);
  assert.match(app, /openFloatingMenu/);
  assert.match(html, /id="goalBar"/);
  assert.match(html, /id="helpDialog"/);
  assert.match(html, /id="historyNodesDialog"/);
  assert.match(html, /id="historyNodesLoading"/);
  assert.match(html, /id="historyNodesCanvas"/);
  assert.match(html, /id="historyNodesRows"/);
  assert.match(html, /id="confirmDialog"/);
  assert.match(css, /\.thread-card\.menu-open/);
  assert.match(css, /#chatMenu\s*\{[^}]*flex:\s*0\s+0\s+40px/);
  assert.match(css, /#chatMenu\s*>\s*summary\s*\{[^}]*display:\s*inline-grid/);
  assert.match(html, /<summary class="icon-button" aria-label="更多操作">⋮<\/summary>/);
  assert.doesNotMatch(html, /topNewTaskButton/);
  assert.doesNotMatch(app, /topNewTaskButton/);
  assert.match(css, /\.floating-popover/);
  assert.match(css, /\.thread-menu-button:hover/);
  assert.match(css, /\.goal-bar/);
  assert.match(css, /\.history-nodes-canvas/);
  assert.match(css, /\.history-nodes-rows/);
  assert.match(css, /\.history-nodes-loading/);
  assert.match(css, /\.history-nodes-loading-banner\s*\{/);
  assert.match(css, /\.history-nodes-list\.focus-loading/);
  assert.match(css, /touch-action:\s*pan-y/);
  assert.match(css, /--action-bg:\s*#/);
  assert.match(css, /\.confirm-actions > button\.primary-button\s*\{[^}]*background:\s*var\(--action-bg\)/);
  assert.match(css, /\.confirm-actions > button\.danger-button\s*\{[^}]*background:\s*var\(--danger-action-bg\)/);
  assert.doesNotMatch(css, /\.directory-create button\.primary-button\s*\{[^}]*var\(--accent\)/);
  assert.match(css, /\.toast\.loading\s*\{/);
  assert.match(css, /\.toast\.loading::before\s*\{/);
  assert.match(app, /function showLoadingToast\(/);
  assert.match(app, /function finishLoadingToast\(/);
  assert.match(historyNodes, /function setHistoryNodesFocusLoading\(/);
  assert.match(historyNodes, /正在加载历史对话节点/);
  assert.match(app, /正在加载完整历史上下文/);
  assert.match(app, /正在加载任务/);
  assert.match(goalActions, /正在保存 Goal/);
  assert.match(app, /加载中……/);
  assert.match(historyNodes, /historyNodesList\.setAttribute\("aria-busy"/);
  assert.match(worker, /codex-pwa-v122/);
});

test("history pages are normalized to chronological order", () => {
  const turns = [{ id: "newest" }, { id: "middle" }, { id: "oldest" }];
  assert.deepEqual(chronologicalTurns(turns, "desc").map((turn) => turn.id), ["oldest", "middle", "newest"]);
  assert.deepEqual(turns.map((turn) => turn.id), ["newest", "middle", "oldest"]);
});

test("history node navigation opens a bidirectional chronological context", async () => {
  const [server, app, historyNodes, historyContext, eventConnection, css] = await Promise.all([
    readServerSources(),
    readAppSources(),
    readProductSource("public/history-nodes.js"),
    readProductSource("public/history-context.js"),
    readProductSource("public/event-connection.js"),
    readProductSource("public/styles.css"),
  ]);
  const focusSource = app.slice(app.indexOf("async function focusHistoryNode"), app.indexOf("function updateChatHeader"));
  const notificationSource = app.slice(app.indexOf("const browsingHistory"), app.indexOf("const follow = shouldFollowOutput"));
  const sendSource = app.slice(app.indexOf("async function sendPrompt"), app.indexOf("async function stopTurn"));

  assert.match(server, /const sortDirection = url\.searchParams\.get\("sort"\) === "asc" \? "asc" : "desc"/);
  assert.match(server, /codex\.request\("thread\/turns\/list",\s*\{[\s\S]*sortDirection: direction/);
  assert.match(historyNodes, /pageCursor/);
  assert.match(focusSource, /items:\s*"full"/);
  assert.match(focusSource, /replaceHistoryContextTurns\(turns, node, page\)/);
  assert.doesNotMatch(focusSource, /mergeTurnsPage/);
  assert.match(app, /sort:\s*direction === "newer" \? "asc" : "desc"/);
  assert.match(historyContext, /history-context-turn/);
  // Chrome exercises history controls placement and keyed window updates.
  assert.match(notificationSource, /markHistoryContextUpdated\(\);\s*return;/);
  assert.match(eventConnection, /runVisibleRecovery/);
  assert.match(sendSource, /await returnToLatestConversation\(\)/);
  assert.match(css, /\.history-context-banner/);
  assert.match(css, /\.history-context-feedback/);
  assert.match(css, /\.toast\s*\{[^}]*top:\s*calc\(var\(--viewport-offset-top\)/);
  assert.doesNotMatch(css, /\.toast\s*\{[^}]*bottom:\s*max\(/);
  assert.match(css, /\.history-context-turn/);
  assert.match(css, /\.turn-group\.history-context-target/);
});

test("diff rendering is chunked without miscounting lines", () => {
  assert.equal(countDiffLines(""), 0);
  assert.equal(countDiffLines("one"), 1);
  assert.equal(countDiffLines("one\ntwo\nthree"), 3);
  assert.equal(nextDiffChunkEnd(1_000, 0, 240), 240);
  assert.equal(nextDiffChunkEnd(1_000, 960, 240), 1_000);
});

test("optimistic user messages reconcile by thread and normalized text", () => {
  const pending = [
    { id: "local-1", threadId: "thread-a", text: normalizeUserMessageText("你好\r\n世界") },
    { id: "local-2", threadId: "thread-b", text: normalizeUserMessageText("你好\n世界") },
  ];
  assert.equal(findPendingUserMessageIndex(pending, "thread-a", "你好\n世界"), 0);
  assert.equal(findPendingUserMessageIndex(pending, "thread-b", "你好\r\n世界"), 1);
  assert.equal(findPendingUserMessageIndex(pending, "thread-c", "你好\n世界"), -1);
});

test("reconciliation reuses and rekeys the optimistic message node", () => {
  const node = { type: "user", element: {}, body: {} };
  const pendingMessages = [{ id: "local-1", threadId: "thread-a", text: "只显示一次" }];
  const itemNodes = new Map([["local-1", node]]);
  const itemTurns = new Map([["local-1", "turn-1"]]);
  const result = reconcilePendingUserMessage({
    pendingMessages,
    itemNodes,
    itemTurns,
    threadId: "thread-a",
    itemId: "server-1",
    text: "只显示一次",
  });
  assert.equal(result, node);
  assert.equal(pendingMessages.length, 0);
  assert.equal(itemNodes.has("local-1"), false);
  assert.equal(itemNodes.get("server-1"), node);
  assert.equal(itemTurns.has("local-1"), false);
  assert.equal(itemTurns.get("server-1"), "turn-1");
});

test("client refreshes task state after foreground recovery", async () => {
  const source = await readAppSources();
  assert.match(source, /visibilitychange/);
  assert.match(source, /setInterval\(refreshVisibleState, 15_000\)/);
  assert.match(source, /thread\/started/);
  assert.match(source, /historyCompleteCursor/);
  assert.match(source, /pages < 25/);
  assert.match(source, /renderHistoryWindow/);
  assert.match(source, /fixedVirtualRange/);
  assert.match(source, /点击左侧主菜单查看历史任务/);
});

test("mobile layout constrains long task titles and dynamic controls", async () => {
  const css = await readProductSource("public/styles.css");
  assert.match(css, /\.main-panel\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.topbar-title\s*\{[^}]*flex:\s*1\s+1\s+0[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.topbar-actions\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  assert.match(css, /\.topbar-actions\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(css, /\.topbar-title\s*\{[^}]*width:\s*min\(calc\(100%\s*-\s*176px\),\s*76vw\)/s);
  assert.match(css, /\.topbar-title h1\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.chat-view\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(css, /\.context-panel:not\(\.open\)|\.context-panel\s*\{[^}]*visibility:\s*hidden/s);
  assert.match(css, /html\s*\{[^}]*overflow:\s*hidden[^}]*overscroll-behavior:\s*none/s);
  assert.match(css, /\.app-shell\s*\{[^}]*position:\s*fixed[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.sidebar\s*\{[^}]*overflow:\s*hidden[^}]*overscroll-behavior:\s*none/s);
  assert.match(css, /\.sidebar\s*\{\s*right:\s*14%/s);
});
