import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createBrowserNotificationController } from "../public/browser-notifications.js";

function fixture({ hidden = false, constructorFails = false, registration = null, storage = null } = {}) {
  const notices = [];
  const document = { visibilityState: hidden ? "hidden" : "visible" };
  class Notification {
    static permission = "granted";
    constructor(title, options) {
      if (constructorFails) throw new TypeError("Use ServiceWorkerRegistration.showNotification");
      notices.push({ title, options });
    }
  }
  const environment = { isSecureContext: true, Notification, document,
    navigator: { serviceWorker: { getRegistration: async () => registration } } };
  const controller = createBrowserNotificationController({ environment, storage,
    getSelectedThreadId: () => "selected", now: () => 1_000_000 });
  return { environment, notices, controller };
}

test("a hidden selected task can notify while the visible task stays quiet", async () => {
  const { controller, environment, notices } = fixture();
  assert.equal(await controller.send({ threadId: "selected", title: "完成" }), false);
  environment.document.visibilityState = "hidden";
  assert.equal(await controller.send({ threadId: "selected", title: "完成" }), true);
  assert.equal(notices.length, 1);
});

test("mobile delivery uses an active worker, deduplicates in flight and records success only", async () => {
  let resolveDelivery;
  const deliveries = [];
  const registration = { active: {}, showNotification: (title, options) => {
    deliveries.push({ title, options });
    return new Promise((resolve) => { resolveDelivery = resolve; });
  } };
  const { controller } = fixture({ constructorFails: true, registration });
  const sending = controller.send({ threadId: "other", title: "完成", body: "结果" });
  assert.equal(await controller.send({ threadId: "other", title: "重复" }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].options.data, { threadId: "other" });
  assert.equal(controller.lastAt.has("other"), false);
  resolveDelivery();
  assert.equal(await sending, true);
  assert.equal(controller.lastAt.has("other"), true);
  assert.equal(await controller.send({ threadId: "other", title: "重复" }), false);
});

test("failed delivery does not suppress a later successful attempt", async () => {
  const registration = { active: {}, showNotification: async () => { throw new Error("not available"); } };
  const { controller } = fixture({ constructorFails: true, registration });
  assert.equal(await controller.send({ threadId: "other", title: "失败" }), false);
  assert.equal(controller.lastAt.has("other"), false);
  registration.showNotification = async () => {};
  assert.equal(await controller.send({ threadId: "other", title: "重试" }), true);
});

test("notification memory and persisted state stay bounded and discard stale or future clocks", async () => {
  const initial = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`old-${index}`, 900_000]));
  Object.assign(initial, { future: 2_000_000, expired: 1 });
  let saved = JSON.stringify(initial);
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  const { controller } = fixture({ storage });
  assert.ok(controller.lastAt.size <= 256);
  assert.equal(controller.lastAt.has("future"), false);
  assert.equal(controller.lastAt.has("expired"), false);
  for (let index = 0; index < 300; index += 1) {
    assert.equal(await controller.send({ threadId: `fresh-${index}`, title: "完成" }), true);
  }
  assert.ok(controller.lastAt.size <= 256);
  assert.ok(Object.keys(JSON.parse(saved)).length <= 256);
  assert.equal(controller.lastAt.has("fresh-299"), true);
  assert.equal(await controller.send({ threadId: "fresh-299", title: "重复" }), false);
});

async function workerFixture(clients) {
  const handlers = new Map();
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  runInNewContext(source, { URL, self: {
    location: { origin: "https://pwa.example" }, clients,
    addEventListener: (name, handler) => handlers.set(name, handler),
  } });
  return async (threadId) => {
    let pending;
    let closed = false;
    assert.equal(typeof handlers.get("notificationclick"), "function");
    handlers.get("notificationclick")({ notification: {
      data: { threadId, url: "https://untrusted.example/" }, close: () => { closed = true; },
    }, waitUntil: (promise) => { pending = promise; } });
    await pending;
    assert.equal(closed, true);
  };
}

test("notification click focuses an existing task without navigating away from drafts", async () => {
  const actions = [];
  const client = { url: "https://pwa.example/?thread=other", focused: false,
    focus: async () => { actions.push("focus"); return client; },
    postMessage: (message) => actions.push(JSON.parse(JSON.stringify(message))),
  };
  const click = await workerFixture({ matchAll: async () => [client],
    openWindow: async () => assert.fail("existing application window should be reused"),
  });
  await click("target");
  assert.deepEqual(actions, ["focus", { type: "OPEN_NOTIFICATION_THREAD", threadId: "target" }]);
});

test("notification click opens a safe task URL when no application window remains", async () => {
  const opened = [];
  const click = await workerFixture({ matchAll: async () => [
    { url: "https://pwa.example/file-preview.html" }, { url: "https://untrusted.example/" },
  ], openWindow: async (url) => opened.push(url) });
  await click("task & details");
  assert.equal(opened.length, 1);
  const url = new URL(opened[0]);
  assert.equal(url.origin, "https://pwa.example");
  assert.equal(url.pathname, "/");
  assert.equal(url.searchParams.get("thread"), "task & details");
});
