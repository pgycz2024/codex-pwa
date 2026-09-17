import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import webPush from "web-push";

async function until(read) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for push fixture");
}

test("HTTP push registration is CSRF/device bound and daemon events deliver after the page disconnects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pwa-push-http-"));
  const project = fileURLToPath(new URL("..", import.meta.url));
  const transportLog = join(root, "delivered.jsonl");
  const preload = join(root, "transport.mjs");
  // Only the outbound provider transport is substituted. Real HTTP, auth,
  // persistence, WebSocket handling, authorization and dispatch remain intact.
  await writeFile(preload, `import { createRequire } from "node:module";
    import { appendFile } from "node:fs/promises";
    const webPush = createRequire(${JSON.stringify(pathToFileURL(join(project, "package.json")).href)})("web-push");
    webPush.sendNotification = async (target, payload, options) => {
      const request = webPush.generateRequestDetails(target, payload, options);
      await appendFile(${JSON.stringify(transportLog)}, JSON.stringify({ payload: JSON.parse(payload), encoding: request.headers["Content-Encoding"] }) + "\\n");
    };`);
  await writeFile(join(root, "password"), "test-only-password", { mode: 0o600 });
  await writeFile(join(root, "push.json"), JSON.stringify({ ...webPush.generateVAPIDKeys(), subject: "https://pwa.example/contact" }), { mode: 0o600 });
  const daemon = createServer();
  const websocket = new WebSocketServer({ server: daemon });
  let connection;
  websocket.on("connection", (socket) => {
    connection = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (!Object.hasOwn(message, "id")) return;
      const result = message.method === "thread/read"
        ? { thread: { id: message.params.threadId, cwd: message.params.threadId === "outside" ? tmpdir() : root } }
        : message.method === "initialize" ? { userAgent: "push-test" } : {};
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise((resolve) => daemon.listen(join(root, "daemon.sock"), resolve));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  let child;
  const stop = async () => {
    if (child?.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  };
  t.after(async () => {
    await stop();
    for (const socket of websocket.clients) socket.terminate();
    websocket.close();
    await new Promise((resolve) => daemon.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  async function start() {
    child = spawn(process.execPath, ["--import", preload, "server.mjs"], { cwd: project, env: {
      ...process.env, NODE_ENV: "test", CODEX_PWA_PORT: String(port), CODEX_PWA_HOST: "127.0.0.1",
      CODEX_PWA_APP_SERVER_MODE: "shared-daemon", CODEX_PWA_DAEMON_SOCKET: join(root, "daemon.sock"),
      CODEX_PWA_ROOTS: root, CODEX_PWA_ROOTS_FILE: join(root, "roots.json"),
      CODEX_PWA_PASSWORD_FILE: join(root, "password"), CODEX_PWA_USERNAME_FILE: join(root, "username"),
      CODEX_PWA_SESSION_FILE: join(root, "sessions.json"), CODEX_PWA_PUSH_CONFIG_FILE: join(root, "push.json"),
      CODEX_PWA_PUSH_STORE_FILE: join(root, "subscriptions.json"),
    }, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostics = "";
    child.stderr.on("data", (data) => { diagnostics = (diagnostics + data).slice(-4000); });
    await until(async () => {
      assert.equal(child.exitCode, null, diagnostics);
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    });
  }
  const readLog = async () => {
    try { return (await readFile(transportLog, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  async function login() {
    const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "codex", password: "test-only-password" }) });
    const session = await response.json();
    return { cookie: response.headers.get("set-cookie").split(";")[0], "content-type": "application/json", "x-codex-pwa-csrf": session.csrfToken };
  }
  const request = (path, headers, options = {}) => fetch(`${base}${path}`, { ...options, headers });
  const emit = (threadId, id) => connection.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id, status: "completed" } } }));
  await start();
  assert.equal((await fetch(`${base}/api/push/status`)).status, 401);
  const a = await login();
  const b = await login();
  const client = createECDH("prime256v1");
  client.generateKeys();
  const body = JSON.stringify({ subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/http-fixture", keys: {
    p256dh: client.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url"),
  } } });
  assert.equal((await request("/api/push/subscription", { ...a, "x-codex-pwa-csrf": "" }, { method: "POST", body })).status, 403);
  assert.equal((await request("/api/push/subscription", a, { method: "POST", body })).status, 200);
  await request("/api/push/subscription", b, { method: "DELETE" });
  assert.equal((await (await request("/api/push/status", a)).json()).subscribed, true);
  assert.equal((await (await request("/api/push/status", b)).json()).subscribed, false);
  // There are no /api/events connections: delivery must be server initiated.
  emit("task", "completed-one");
  await until(async () => (await readLog()).length === 1);
  assert.equal((await readLog())[0].encoding, "aes128gcm");
  await stop();
  await start();
  assert.equal((await (await request("/api/push/status", a)).json()).subscribed, true);
  emit("task", "completed-one");
  emit("outside", "outside-turn");
  emit("task", "completed-two");
  await until(async () => (await readLog()).length === 2);
  assert.deepEqual((await readLog()).map(({ payload }) => payload.threadId), ["task", "task"]);
  assert.equal((await request("/api/auth/logout", a, { method: "POST", body: "{}" })).status, 200);
  assert.equal(JSON.parse(await readFile(join(root, "subscriptions.json"), "utf8")).subscriptions.length, 0);
  emit("task", "after-logout");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await readLog()).length, 2);
});
