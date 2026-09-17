import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

async function until(read, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for task recovery");
}

test("crash and bridge reconnect recover an active task without SSE, resume or daemon writes", { timeout: 45_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pwa-recovery-http-"));
  const journal = join(root, "tasks.json");
  const replay = join(root, "events.jsonl");
  const daemon = createServer();
  const websocket = new WebSocketServer({ server: daemon });
  let connection;
  let connections = 0;
  let holdReads = false;
  let outside = false;
  let turn = { id: "turn-one", status: "inProgress" };
  const methods = [];
  const delayed = [];
  websocket.on("connection", (socket) => {
    connection = socket;
    connections += 1;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (!Object.hasOwn(message, "id")) return;
      methods.push(message.method);
      const reply = () => {
        if (socket.readyState !== 1) return;
        let result = {};
        if (message.method === "initialize") result = { userAgent: "recovery-fixture" };
        if (message.method === "thread/read") result = { thread: { id: message.params.threadId,
          cwd: outside ? tmpdir() : root, status: { type: turn.status === "inProgress" ? "active" : "idle" } } };
        if (message.method === "thread/turns/list") {
          assert.equal(message.params.itemsView, "notLoaded", "recovery must not fetch message bodies");
          assert.equal(message.params.limit, 1);
          result = { data: [turn], nextCursor: null, backwardsCursor: null };
        }
        socket.send(JSON.stringify({ id: message.id, result }));
      };
      if (holdReads && message.method === "thread/read") delayed.push(reply);
      else reply();
    });
  });
  await new Promise((resolve) => daemon.listen(join(root, "daemon.sock"), resolve));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child;
  async function stop(signal = "SIGTERM") {
    if (child?.exitCode === null && child.signalCode === null) { child.kill(signal); await once(child, "exit"); }
  }
  t.after(async () => {
    await stop();
    for (const socket of websocket.clients) socket.terminate();
    websocket.close();
    await new Promise((resolve) => daemon.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  async function start() {
    child = spawn(process.execPath, ["server.mjs"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env,
        NODE_ENV: "production", CODEX_PWA_PORT: String(port), CODEX_PWA_HOST: "127.0.0.1",
        CODEX_PWA_APP_SERVER_MODE: "shared-daemon", CODEX_PWA_DAEMON_SOCKET: join(root, "daemon.sock"),
        CODEX_PWA_ROOTS: root, CODEX_PWA_ROOTS_FILE: join(root, "roots.json"),
        CODEX_PWA_PASSWORD_FILE: "", CODEX_PWA_USERNAME_FILE: join(root, "username"),
        CODEX_PWA_SESSION_FILE: join(root, "sessions.json"), CODEX_PWA_PUSH_CONFIG_FILE: "",
        CODEX_PWA_TASK_RECOVERY_FILE: journal, CODEX_PWA_EVENT_REPLAY_FILE: replay,
      }, stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostics = "";
    child.stderr.on("data", (data) => { diagnostics = (diagnostics + data).slice(-2000); });
    await until(async () => {
      assert.equal(child.exitCode, null, diagnostics);
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    });
  }
  const status = async () => (await fetch(`${base}/api/status`)).json();
  const emit = (method, value = turn) => connection.send(JSON.stringify({ method, params: { threadId: "task", turn: value } }));
  const records = async () => (await readFile(replay, "utf8")).trim().split("\n").map(JSON.parse).map((entry) => entry.payload);
  await start();
  emit("turn/started");
  await until(async () => (await status()).taskRecovery.running === 1);
  await stop("SIGKILL");
  assert.equal(daemon.listening, true);
  holdReads = true;
  await start();
  await until(() => delayed.length > 0);
  const unconfirmed = await status();
  assert.equal(unconfirmed.taskRecovery.unconfirmed, 1);
  assert.deepEqual(unconfirmed.activeTurns, {});
  holdReads = false;
  delayed.splice(0).forEach((reply) => reply());
  await until(async () => (await status()).activeTurns.task === "turn-one");
  assert.deepEqual((await status()).ownedThreads, [], "observing a recovered task is not writer ownership");
  turn = { id: "turn-two", status: "inProgress" };
  emit("turn/started");
  emit("turn/completed", { id: "turn-one", status: "completed" });
  await until(async () => (await status()).activeTurns.task === "turn-two");
  connection.terminate();
  await until(() => connections === 3);
  await until(async () => (await status()).activeTurns.task === "turn-two");
  assert.deepEqual((await status()).ownedThreads, []);
  // The daemon finishes silently while the application has no browser or SSE
  // connection. Only the independent recovery timer can discover this result.
  turn = { id: "turn-two", status: "completed" };
  await until(async () => JSON.parse(await readFile(journal, "utf8")).tasks[0]?.status === "completed", 20_000);
  assert.deepEqual((await status()).activeTurns, {});
  assert.equal((await records()).filter((entry) => entry.kind === "bridge/taskRecovered"
    && entry.turnId === "turn-two" && entry.status === "completed").length, 1);
  await stop();
  await start();
  assert.equal((await status()).taskRecovery.completed, 1);
  assert.equal((await records()).filter((entry) => entry.kind === "bridge/taskRecovered"
    && entry.turnId === "turn-two" && entry.status === "completed").length, 1, "restart does not announce a terminal task again");
  // Removing access while disconnected must drop the private tracker and avoid
  // broadcasting the task's subsequent state.
  turn = { id: "turn-three", status: "inProgress" };
  emit("turn/started");
  await until(async () => (await status()).taskRecovery.running === 1);
  const beforeRemoval = (await records()).filter((entry) => entry.kind === "bridge/taskRecovered").length;
  outside = true;
  connection.terminate();
  await until(() => connections === 5);
  await until(async () => (await status()).taskRecovery.tracked === 0);
  assert.equal((await records()).filter((entry) => entry.kind === "bridge/taskRecovered").length, beforeRemoval);
  assert.deepEqual([...new Set(methods)].sort(), ["initialize", "thread/read", "thread/turns/list"].sort());
});
