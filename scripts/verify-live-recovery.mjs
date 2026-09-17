// Opt-in acceptance against one already-running task. The relay never forwards
// mutations, subscriptions, approvals, task bodies, or requests for another task.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
export function permittedRecoveryRead(message, threadId) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) return false;
  if (message.method === "initialize") return Object.hasOwn(message, "id");
  if (message.method === "initialized") return !Object.hasOwn(message, "id");
  if (!Object.hasOwn(message, "id") || message.params?.threadId !== threadId) return false;
  const keys = Object.keys(message.params || {});
  if (message.method === "thread/read") return message.params.includeTurns === false
    && keys.every((key) => ["threadId", "includeTurns"].includes(key));
  if (message.method === "thread/turns/list") return message.params.limit === 1
    && message.params.itemsView === "notLoaded" && message.params.sortDirection === "desc"
    && keys.every((key) => ["threadId", "limit", "itemsView", "sortDirection"].includes(key));
  return false;
}

export async function verifyLiveRecovery({ socketPath, threadId }) {
  assert.ok(isAbsolute(socketPath), "An absolute existing daemon socket is required");
  assert.match(threadId, /^[a-f0-9-]{36}$/i, "An explicit task UUID is required");
  const scratch = await mkdtemp(join(tmpdir(), "pwa-live-recovery-"));
  const journal = join(scratch, "recovery.json"), replay = join(scratch, "events.jsonl");
  const relay = createServer(), websocket = new WebSocketServer({ server: relay });
  const peers = new Set(), held = [], blocked = [], methods = new Set();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 120_000);
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let child, childClosed, probe, observerClient, gate = false, connections = 0, base, cookie = "";
  const checks = [];
  const pass = (name) => { checks.push(name); console.log(`PASS ${name}`); };
  const socketFingerprint = async () => {
    const value = await stat(socketPath);
    return [value.dev, value.ino, value.mtimeMs];
  };
  const before = await socketFingerprint();
  websocket.on("connection", (client) => {
    connections += 1;
    if (!observerClient) observerClient = client;
    peers.add(client);
    const upstream = new WebSocket("ws://localhost/", { perMessageDeflate: false, handshakeTimeout: 5000,
      maxPayload: 8 * 1024 * 1024, createConnection: () => createConnection({ path: socketPath }) });
    peers.add(upstream);
    const queued = [], ids = new Set();
    const forward = (raw) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(raw, { binary: false });
      else if (upstream.readyState === WebSocket.CONNECTING && queued.length < 16) queued.push(raw);
    };
    upstream.on("open", () => { for (const raw of queued.splice(0)) upstream.send(raw, { binary: false }); });
    client.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { blocked.push("invalid JSON"); return; }
      if (!permittedRecoveryRead(message, threadId)) {
        blocked.push(String(message.method || "response").slice(0, 80));
        client.send(JSON.stringify({ id: message.id ?? null, error: { code: -32601, message: "Read-only acceptance relay" } }));
        return;
      }
      methods.add(message.method);
      if (Object.hasOwn(message, "id")) ids.add(message.id);
      // Delay only metadata reads, allowing initialize/status health to finish.
      if (gate && message.method === "thread/read") held.push(() => {
        if (client.readyState === WebSocket.OPEN) forward(raw);
      });
      else forward(raw);
    });
    upstream.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      // No subscriptions: discard unsolicited notifications and server requests.
      if (!Object.hasOwn(message, "method") && ids.delete(message.id) && client.readyState === WebSocket.OPEN) client.send(raw, { binary: false });
    });
    client.on("close", () => { peers.delete(client); upstream.terminate(); });
    upstream.on("close", () => { peers.delete(upstream); client.terminate(); });
    client.on("error", () => upstream.terminate());
    upstream.on("error", () => client.terminate());
  });

  async function until(read, label) {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      abort.signal.throwIfAborted();
      if (await read()) return;
      await delay(30, undefined, { signal: abort.signal });
    }
    throw new Error(`Timed out: ${label}`);
  }
  async function stop(signal = "SIGTERM") {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { await childClosed; } finally { clearTimeout(kill); }
    }
  }
  const request = (path, options = {}) => fetch(`${base}${path}`, { ...options,
    headers: { cookie, ...options.headers }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
  const status = async () => {
    const response = await request("/api/status");
    assert.equal(response.status, 200, "The original login must remain valid");
    return response.json();
  };
  const releaseReads = () => { gate = false; for (const release of held.splice(0)) release(); };
  try {
    await new Promise((ready) => relay.listen(join(scratch, "readonly.sock"), ready));
    probe = new WebSocket("ws://localhost/", { createConnection: () => createConnection({ path: join(scratch, "readonly.sock") }) });
    probe.on("error", () => {});
    await once(probe, "open");
    const pending = new Map();
    let nextId = 0;
    probe.on("message", (raw) => {
      const message = JSON.parse(raw);
      pending.get(message.id)?.(message);
    });
    const rpc = (method, params) => new Promise((resolveRequest, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Read timed out: ${method}`)); }, 10_000);
      pending.set(id, (message) => {
        clearTimeout(timer); pending.delete(id);
        if (message.error) reject(new Error(`Read rejected: ${method} (${message.error.code})`));
        else resolveRequest(message.result);
      });
      probe.send(JSON.stringify({ id, method, params }));
    });
    const init = await rpc("initialize", { clientInfo: { name: "pwa_recovery_readonly_probe", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    probe.send(JSON.stringify({ method: "initialized", params: {} }));
    const readThread = async () => (await rpc("thread/read", { threadId, includeTurns: false })).thread;
    const readTurn = async () => (await rpc("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })).data?.[0];
    const thread = await readThread(), turn = await readTurn();
    assert.equal(thread.status?.type, "active", "The target must actually be running");
    assert.equal(turn?.status, "inProgress", "A current running turn is required");
    assert.ok(isAbsolute(thread.cwd) && !thread.cwd.includes(":"), "The target must have a usable local root");
    assert.equal(turn.items?.length, 0, "The probe must not retrieve task content");
    pass("real daemon confirms an active task without loading message bodies");
    // Seed only the observation journal from the real snapshot. This does not
    // claim to test the original live turn/started delivery or a subscription.
    await writeFile(journal, JSON.stringify({ version: 1, tasks: [{ threadId, turnId: turn.id, status: "running", observedAt: Date.now() }] }), { mode: 0o600 });
    const password = randomBytes(24).toString("hex");
    await writeFile(join(scratch, "password"), password, { mode: 0o600 });
    await writeFile(join(scratch, "username"), "recovery-probe", { mode: 0o600 });
    const reservation = createServer();
    await new Promise((ready) => reservation.listen(0, "127.0.0.1", ready));
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    base = `http://127.0.0.1:${port}`;
    async function start() {
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEX_PWA_")));
      child = spawn(process.execPath, ["server.mjs"], { cwd: source, stdio: "ignore", env: {
        ...inherited, NODE_ENV: "production", CODEX_PWA_HOST: "127.0.0.1", CODEX_PWA_PORT: String(port),
        CODEX_PWA_APP_SERVER_MODE: "shared-daemon", CODEX_PWA_DAEMON_SOCKET: join(scratch, "readonly.sock"),
        CODEX_PWA_ROOTS: thread.cwd, CODEX_PWA_ROOTS_FILE: join(scratch, "roots.json"),
        CODEX_PWA_PASSWORD_FILE: join(scratch, "password"), CODEX_PWA_USERNAME_FILE: join(scratch, "username"),
        CODEX_PWA_SESSION_FILE: join(scratch, "devices.json"), CODEX_PWA_TASK_RECOVERY_FILE: journal,
        CODEX_PWA_EVENT_REPLAY_FILE: replay, CODEX_PWA_PUSH_CONFIG_FILE: "", CODEX_PWA_PUSH_STORE_FILE: join(scratch, "push.json"),
      } });
      childClosed = new Promise((done) => child.once("close", done));
      child.on("error", () => {});
      await until(async () => {
        assert.equal(child.exitCode, null, "Temporary PWA must remain alive");
        try { return (await (await request("/api/health")).json()).bridge === "ready"; } catch { return false; }
      }, "temporary PWA startup");
    }
    async function verifyRecovery() {
      await until(() => held.length > 0, "held read");
      const waiting = await status();
      assert.equal(waiting.taskRecovery.unconfirmed, 1);
      assert.equal(waiting.activeTurns[threadId], undefined);
      releaseReads();
      await until(async () => (await status()).activeTurns[threadId] === turn.id, "actual turn recovery");
      const recovered = await status();
      assert.equal(recovered.taskRecovery.running, 1);
      assert.deepEqual(recovered.ownedThreads, []);
      assert.deepEqual(recovered.pendingApprovals, []);
      const stored = JSON.parse(await readFile(journal, "utf8"));
      assert.equal(stored.tasks[0].status, "running");
      assert.deepEqual(Object.keys(stored.tasks[0]).sort(), ["observedAt", "status", "threadId", "turnId"]);
      assert.equal((await stat(journal)).mode & 0o777, 0o600);
    }
    gate = true;
    await start();
    assert.equal((await request("/api/status")).status, 401);
    const login = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "recovery-probe", password, remember: true }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie").split(";")[0];
    await verifyRecovery();
    pass("cold startup shows unconfirmed until real read-only recovery completes");

    const connectionCount = connections;
    gate = true;
    // Close only temporary PWA connections. Keep the independent metadata probe.
    for (const client of websocket.clients) if (client !== observerClient) client.terminate();
    await until(() => connections > connectionCount, "temporary bridge reconnect");
    await verifyRecovery();
    pass("bridge disconnect reconnects without claiming task ownership");

    gate = true;
    const previousPid = child.pid;
    await stop("SIGKILL");
    await start();
    assert.notEqual(child.pid, previousPid);
    await verifyRecovery();
    pass("SIGKILL restart preserves login and recovers the same running turn");
    const records = (await readFile(replay, "utf8")).trim().split("\n").map(JSON.parse);
    const recoveredEvents = records.filter((entry) => entry.payload.kind === "bridge/taskRecovered");
    assert.equal(recoveredEvents.length, 3);
    assert.ok(recoveredEvents.every((entry) => entry.payload.threadId === threadId && entry.payload.turnId === turn.id && entry.payload.status === "running"));
    const response = await request("/api/events", { headers: { "last-event-id": String(recoveredEvents[0].id) } });
    const reader = response.body.getReader();
    let frames = "";
    try {
      while (!frames.includes(`id: ${recoveredEvents.at(-1).id}\n`)) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        frames += new TextDecoder().decode(value);
        assert.ok(frames.length < 256 * 1024);
      }
    } finally { await reader.cancel(); }
    const frame = frames.split("\n\n").find((value) => value.startsWith(`id: ${recoveredEvents.at(-1).id}\n`));
    assert.deepEqual(JSON.parse(frame.split("\ndata: ")[1]), recoveredEvents.at(-1).payload);
    assert.equal((await readThread()).status?.type, "active");
    const finalTurn = await readTurn();
    assert.ok(finalTurn.id === turn.id && finalTurn.status === "inProgress", "The real turn must remain running");
    assert.equal(blocked.length, 0, "PWA must not attempt any forbidden request");
    assert.ok(JSON.stringify(await socketFingerprint()) === JSON.stringify(before), "The shared daemon socket must remain unchanged");
    pass("persisted recovery SSE replays intact while the actual turn continues");
    return { checks: checks.length, version: init.userAgent?.match(/\d+\.\d+\.\d+/)?.[0],
      methods: [...methods].sort(), sameTurnRunning: true, recoveredEvents: recoveredEvents.length,
      observedTurnAgeSeconds: Number.isFinite(turn.startedAt) ? Math.floor(Date.now() / 1000 - turn.startedAt) : null,
      daemonSocketUnchanged: true, externalPushEnabled: false };
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await stop();
    probe?.terminate();
    for (const peer of peers) peer.terminate();
    websocket.close();
    if (relay.listening) await new Promise((done) => relay.close(done));
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/verify-live-recovery.mjs DAEMON_SOCKET THREAD_ID");
    console.log(JSON.stringify(await verifyLiveRecovery({ socketPath: process.argv[2], threadId: process.argv[3] })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
