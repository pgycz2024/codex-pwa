import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webPush from "web-push";
import { PushService, validatePushSubscription, validateVapidConfiguration } from "../push-service.mjs";

function subscription(endpoint = "https://fcm.googleapis.com/fcm/send/test-only") {
  const client = createECDH("prime256v1");
  client.generateKeys();
  return { endpoint, keys: { p256dh: client.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "pwa-push-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = webPush.generateVAPIDKeys();
  const configFile = join(root, "keys.json");
  const storeFile = join(root, "subscriptions.json");
  await writeFile(configFile, JSON.stringify({ ...keys, subject: "https://pwa.example/contact" }), { mode: 0o600 });
  const devices = new Set(["device-a", "device-b"]);
  const deliveries = [];
  const options = { configFile, storeFile,
    authStore: { enabled: true, listSessions: async () => [...devices].map((id) => ({ id })) },
    readThread: async () => ({ cwd: root }), isRequestPending: () => true,
    sendNotification: async (target, payload, settings) => { deliveries.push({ target, payload: JSON.parse(payload), settings }); },
    ...overrides,
  };
  const service = new PushService(options);
  return { service, options, devices, deliveries, root, storeFile, keys };
}

const completed = (threadId = "task", id = "turn-one") => ({ kind: "app-server/notification",
  message: { method: "turn/completed", params: { threadId, turn: { id, status: "completed" } } } });

test("push endpoints and keys reject local destinations, credentials, ports and malformed keys", () => {
  for (const endpoint of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://localhost/x",
    "https://fcm.googleapis.com.evil.example/x", "https://user@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x"]) {
    assert.throws(() => validatePushSubscription(subscription(endpoint)));
  }
  const valid = subscription();
  assert.deepEqual(validatePushSubscription({ ...valid, arbitrary: "ignored" }), valid);
  assert.throws(() => validatePushSubscription({ ...valid, keys: { ...valid.keys, p256dh: "invalid" } }));
});

test("private push configuration accepts explicit HTTP proxies and rejects malformed routes", () => {
  const config = { ...webPush.generateVAPIDKeys(), subject: "https://pwa.example/contact" };
  assert.equal(validateVapidConfiguration(config).proxy, undefined);
  assert.equal(validateVapidConfiguration({ ...config, proxy: "http://127.0.0.1:3128" }).proxy, "http://127.0.0.1:3128/");
  assert.equal(validateVapidConfiguration({ ...config, proxy: "https://proxy.example:8443" }).proxy, "https://proxy.example:8443/");
  for (const proxy of [false, {}, "socks5://localhost:1080", "file:///tmp/proxy", "http://proxy.example/path", "http://proxy.example/?password=private", "http://proxy.example/#secret", "http://proxy.example/\n"]) {
    assert.throws(() => validateVapidConfiguration({ ...config, proxy }), /代理配置无效/);
  }
});

test("configured push transport reaches an actual CONNECT proxy and keeps its credentials private", async (t) => {
  const proxy = createServer();
  const connections = new Set();
  const requests = [];
  proxy.on("connection", (socket) => { connections.add(socket); socket.on("close", () => connections.delete(socket)); });
  proxy.on("connect", (request, socket) => {
    requests.push({ target: request.url, authorization: request.headers["proxy-authorization"] });
    // A controlled rejection verifies proxy routing without reaching a vendor
    // or requiring a real device, certificate override, or external network.
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of connections) socket.destroy(); await new Promise((resolve) => proxy.close(resolve)); });
  const proxyUrl = `http://proxy-test:private-fixture@127.0.0.1:${proxy.address().port}/`;
  const f = await fixture(t, { retryDelay: async () => {}, sendNotification: async (target, payload, options) => {
    // Fail locally before any outbound request if configuration was discarded.
    assert.equal(options.proxy, proxyUrl);
    return webPush.sendNotification(target, payload, options);
  } });
  const config = JSON.parse(await readFile(f.options.configFile, "utf8"));
  await writeFile(f.options.configFile, JSON.stringify({ ...config, proxy: proxyUrl }));
  await f.service.subscribe("device-a", subscription());
  await f.service.enqueue(completed());
  assert.deepEqual(requests, [{ target: "fcm.googleapis.com:443", authorization: `Basic ${Buffer.from("proxy-test:private-fixture").toString("base64")}` }]);
  const status = await f.service.status("device-a");
  assert.equal(status.delivery.ok, false);
  assert.equal(status.delivery.statusCode, 403);
  assert.doesNotMatch(JSON.stringify(status), /private-fixture|proxy-test|127\.0\.0\.1/);
  assert.doesNotMatch(await readFile(f.storeFile, "utf8"), /private-fixture|proxy-test|127\.0\.0\.1/);
});

test("push subscriptions persist privately, and delivery needs no browser event connection", async (t) => {
  const f = await fixture(t);
  const target = subscription();
  await f.service.subscribe("device-a", target);
  assert.equal((await f.service.status("device-a")).subscribed, true);
  assert.equal((await stat(f.storeFile)).mode & 0o777, 0o600);
  const restored = new PushService(f.options);
  await restored.enqueue(completed());
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].payload.threadId, "task");
  assert.equal(f.deliveries[0].payload.title, "Codex 任务已完成");
  assert.equal(f.deliveries[0].settings.contentEncoding, "aes128gcm");
  assert.equal(f.deliveries[0].settings.TTL, 300);
  assert.equal(JSON.stringify(await restored.status("device-a")).includes(target.endpoint), false);
  assert.equal(JSON.stringify(await restored.status("device-a")).includes(f.keys.privateKey), false);
  await new PushService(f.options).enqueue(completed());
  assert.equal(f.deliveries.length, 1, "delivery receipts survive a bridge restart");
});

test("revoked devices, removed roots and resolved approvals do not receive queued push", async (t) => {
  let allowed = true;
  let pending = true;
  const f = await fixture(t, { readThread: async () => { if (!allowed) throw new Error("outside roots"); },
    isRequestPending: () => pending });
  await f.service.subscribe("device-a", subscription());
  f.devices.delete("device-a");
  await f.service.enqueue(completed());
  assert.equal(f.deliveries.length, 0);
  assert.equal((await f.service.status("device-a")).subscribed, false);
  f.devices.add("device-a");
  await f.service.subscribe("device-a", subscription());
  allowed = false;
  await f.service.enqueue(completed());
  assert.equal(f.deliveries.length, 0);
  allowed = true;
  pending = false;
  await f.service.enqueue({ kind: "app-server/request", requestId: "approval", params: { threadId: "task", command: "secret command" } });
  assert.equal(f.deliveries.length, 0);
});

test("recovered completions share delivery receipts with live completions", async (t) => {
  const f = await fixture(t);
  await f.service.subscribe("device-a", subscription());
  const recovered = (status) => ({ kind: "bridge/taskRecovered", threadId: "task", turnId: "turn-one", status });
  await f.service.enqueue(recovered("running"));
  assert.equal(f.deliveries.length, 0);
  await f.service.enqueue(recovered("completed"));
  await f.service.enqueue(completed());
  await new PushService(f.options).enqueue(recovered("completed"));
  assert.equal(f.deliveries.length, 1);
});

test("reused approval ids neither deliver stale reminders nor suppress the new request", async (t) => {
  let current = "first";
  const f = await fixture(t, { isRequestPending: (id, threadId, token) => token === current });
  await f.service.subscribe("device-a", subscription());
  const approval = (requestToken) => ({ kind: "app-server/request", requestId: "reused", requestToken, params: { threadId: "task" } });
  await f.service.enqueue(approval("first"));
  current = "second";
  await f.service.enqueue(approval("first"));
  await f.service.enqueue(approval("second"));
  assert.equal(f.deliveries.length, 2);
  assert.notEqual(f.deliveries[0].payload.eventKey, f.deliveries[1].payload.eventKey);
  assert.equal(f.deliveries[1].payload.requestToken, undefined, "internal request identity is not notification content");
});

test("an expired endpoint is removed and delivery failures do not expose provider errors", async (t) => {
  const f = await fixture(t, { sendNotification: async () => { throw Object.assign(new Error("private provider detail"), { statusCode: 410 }); } });
  await f.service.subscribe("device-a", subscription());
  await f.service.enqueue(completed());
  assert.equal((await f.service.status("device-a")).subscribed, false);
  assert.equal((await readFile(f.storeFile, "utf8")).includes("private provider detail"), false);
});

test("push contains status only and never transmits prompts, commands or error details", async (t) => {
  const f = await fixture(t);
  await f.service.subscribe("device-a", subscription());
  await f.service.enqueue({ kind: "app-server/request", requestId: "approval", method: "item/commandExecution/requestApproval",
    params: { threadId: "task", command: "secret command", cwd: "/private/path" } });
  const failed = completed("task", "failed-turn");
  failed.message.params.turn.status = "failed";
  failed.message.params.turn.error = { message: "private API key or server path" };
  await f.service.enqueue(failed);
  assert.equal(f.deliveries.length, 2);
  assert.equal(f.deliveries[1].payload.title, "Codex 任务失败");
  assert.doesNotMatch(JSON.stringify(f.deliveries.map(({ payload }) => payload)), /secret command|private|API key/);
  const stopped = completed("task", "stopped-turn");
  stopped.message.params.turn.status = "interrupted";
  await f.service.enqueue(stopped);
  assert.equal(f.deliveries[2].payload.title, "Codex 任务已停止");
  const unknown = completed("task", "unknown-turn");
  unknown.message.params.turn.status = "futureStatus";
  await f.service.enqueue(unknown);
  assert.equal(f.deliveries.length, 3, "an unknown status must never become a success notification");
});

test("transient provider failure retries once and rechecks device revocation before retry", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { retryDelay: async () => {}, sendNotification: async () => {
    if (++attempts === 1) throw Object.assign(new Error("busy"), { statusCode: 503 });
  } });
  await f.service.subscribe("device-a", subscription());
  await f.service.enqueue(completed());
  assert.equal(attempts, 2);
  assert.equal((await f.service.status("device-a")).delivery.ok, true);
  attempts = 0;
  f.service.retryDelay = async () => { f.devices.delete("device-a"); };
  await f.service.enqueue(completed("task", "second"));
  assert.equal(attempts, 1);
});

test("failed persistence cannot leave a successful-looking in-memory subscription", async (t) => {
  const f = await fixture(t);
  f.service.persist = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  await assert.rejects(f.service.subscribe("device-a", subscription()), /disk full/);
  assert.equal((await f.service.status("device-a")).subscribed, false);
  await f.service.enqueue(completed());
  assert.equal(f.deliveries.length, 0);
});

test("disabled or unauthenticated instances cannot establish persistent push subscriptions", async (t) => {
  const f = await fixture(t, { configFile: "" });
  assert.equal((await f.service.status("device-a")).configured, false);
  await assert.rejects(f.service.subscribe("device-a", subscription()));
  const unauthenticated = new PushService({ ...f.options, authStore: { enabled: false } });
  assert.equal((await unauthenticated.status()).configured, false);
});

test("the real transport produces decryptable aes128gcm and a valid endpoint-bound VAPID signature", async (t) => {
  const client = createECDH("prime256v1");
  client.generateKeys();
  const auth = randomBytes(16).toString("base64url");
  const target = { endpoint: "https://fcm.googleapis.com/fcm/send/encryption-test", keys: {
    p256dh: client.getPublicKey().toString("base64url"), auth,
  } };
  let request;
  const f = await fixture(t, { sendNotification: async (...args) => { request = webPush.generateRequestDetails(...args); } });
  await f.service.subscribe("device-a", target);
  await f.service.enqueue(completed());
  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
  assert.equal(request.body.includes(Buffer.from("Codex")), false);
  const ece = createRequire(import.meta.resolve("web-push"))("http_ece");
  const plain = ece.decrypt(request.body, { version: "aes128gcm", privateKey: client, authSecret: auth });
  assert.equal(JSON.parse(plain.toString()).threadId, "task");
  const jwt = request.headers.Authorization.match(/t=([^, ]+)/)[1];
  const [header, claims, signature] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(claims, "base64url")).aud, "https://fcm.googleapis.com");
  const key = Buffer.from(f.keys.publicKey, "base64url");
  const publicKey = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256",
    x: key.subarray(1, 33).toString("base64url"), y: key.subarray(33).toString("base64url") } });
  assert.equal(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true);
});
