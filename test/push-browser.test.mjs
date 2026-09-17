import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createPushNotificationController } from "../public/push-notifications.js";

function controllerFixture({ rejectSave = false, registrationWait, saveWait } = {}) {
  const calls = [];
  const toasts = [];
  const nodes = Object.fromEntries(["notificationStatus", "enablePushButton", "disablePushButton", "enablePageNotificationButton",
    "notificationLabel", "notificationButton", "notificationDialog", "closeNotificationButton"].map((key) => [key, {
    attributes: {}, listeners: {}, open: false,
    addEventListener(name, listener) { this.listeners[name] = listener; },
    setAttribute(name, value) { this.attributes[name] = value; },
    showModal() { this.open = true; }, close() { this.open = false; },
  }]));
  let subscribed = false;
  let browserSubscription = null;
  const subscription = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/example" }),
    unsubscribe: async () => { calls.push("unsubscribe"); browserSubscription = null; return true; } };
  const registration = { pushManager: {
    getSubscription: async () => browserSubscription,
    subscribe: async (options) => {
      calls.push(options);
      await registrationWait;
      browserSubscription = subscription;
      return subscription;
    },
  } };
  const environment = { isSecureContext: true, atob, PushManager: {}, Notification: { permission: "granted" },
    navigator: { serviceWorker: { ready: Promise.resolve(registration), getRegistration: async () => registration } } };
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET" });
    if (options.method === "POST") {
      await saveWait;
      if (rejectSave) throw new Error("test save failed");
      subscribed = true;
    } else if (options.method === "DELETE") subscribed = false;
    return { configured: true, subscribed, publicKey: Buffer.alloc(65, 7).toString("base64url") };
  };
  const controller = createPushNotificationController({ environment, api, elements: nodes,
    onToast: (message) => toasts.push(message),
    pageNotifications: { sync() {}, enable: async () => {} } });
  return { controller, calls, nodes, environment, toasts };
}

// Drain the pending promise continuations without advancing the slow-service clock.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("slow native push registration stays pending across dialog reopen and awaits server confirmation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registration = Promise.withResolvers();
  const save = Promise.withResolvers();
  const { controller, calls, nodes, toasts } = controllerFixture({ registrationWait: registration.promise, saveWait: save.promise });
  await controller.refresh();
  controller.open();
  await settle();
  const enabling = controller.enable();
  await settle();
  assert.match(nodes.notificationStatus.textContent, /正在.*注册/);
  assert.notEqual(nodes.notificationDialog.attributes["aria-busy"], "true", "live progress must not be deferred by a busy dialog ancestor");
  t.mock.timers.tick(9_999);
  assert.doesNotMatch(nodes.notificationStatus.textContent, /较久/);
  t.mock.timers.tick(1);
  assert.match(nodes.notificationStatus.textContent, /较久/);
  assert.match(nodes.notificationStatus.textContent, /关闭.*窗口/);
  assert.match(nodes.notificationStatus.textContent, /保持.*页面/);
  assert.equal(controller.enabled(), false);
  assert.equal(nodes.enablePushButton.disabled, true);
  assert.equal(nodes.disablePushButton.disabled, true);
  assert.equal(nodes.enablePageNotificationButton.disabled, true);
  assert.equal(toasts.length, 0, "waiting must not be reported as success or failure");
  assert.equal(await controller.enable(), false);
  const callCount = calls.length;
  nodes.closeNotificationButton.listeners.click();
  assert.equal(nodes.notificationDialog.open, false);
  controller.open();
  assert.equal(nodes.notificationDialog.open, true);
  assert.match(nodes.notificationStatus.textContent, /较久/);
  assert.equal(calls.length, callCount, "reopening must not refresh or restart in-flight registration");
  assert.equal(calls.filter((call) => call.userVisibleOnly).length, 1);

  registration.resolve();
  await settle();
  assert.match(nodes.notificationStatus.textContent, /正在.*保存/);
  assert.equal(controller.enabled(), false, "native registration alone does not confirm server delivery");
  t.mock.timers.tick(60_000);
  assert.match(nodes.notificationStatus.textContent, /正在.*保存/);
  assert.doesNotMatch(nodes.notificationStatus.textContent, /较久/);
  nodes.closeNotificationButton.listeners.click();
  save.resolve();
  assert.equal(await enabling, true);
  assert.equal(nodes.notificationDialog.open, false, "completion must not reopen the dialog");
  assert.match(toasts.at(-1), /已开启/);
  assert.equal(controller.enabled(), true);
  t.mock.timers.tick(60_000);
  assert.match(nodes.notificationStatus.textContent, /已开启/);
  assert.equal(nodes.disablePushButton.disabled, false);
});

test("native registration failure clears waiting feedback and allows a fresh attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registration = Promise.withResolvers();
  const { controller, calls, nodes, toasts } = controllerFixture({ registrationWait: registration.promise });
  await controller.refresh();
  const enabling = controller.enable();
  await settle();
  t.mock.timers.tick(10_000);
  assert.match(nodes.notificationStatus.textContent, /较久/);
  registration.reject(new Error("test native registration failed"));
  assert.equal(await enabling, false);
  assert.equal(controller.enabled(), false);
  assert.equal(nodes.enablePushButton.disabled, false);
  assert.equal(toasts.at(-1), "test native registration failed");
  assert.equal(calls.some((call) => call.method === "POST" || call === "unsubscribe"), false);
  const status = nodes.notificationStatus.textContent;
  t.mock.timers.tick(60_000);
  assert.equal(nodes.notificationStatus.textContent, status);
  assert.doesNotMatch(status, /^正在|较久/);
  await controller.enable();
  assert.equal(calls.filter((call) => call.userVisibleOnly).length, 2);
});

test("fast registration completion or server rejection never gets overwritten by a delayed hint", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const rejectSave of [false, true]) {
    const { controller, calls, nodes, toasts } = controllerFixture({ rejectSave });
    await controller.refresh();
    assert.equal(await controller.enable(), !rejectSave);
    const status = nodes.notificationStatus.textContent;
    t.mock.timers.tick(60_000);
    assert.equal(nodes.notificationStatus.textContent, status);
    assert.doesNotMatch(status, /^正在|较久/);
    assert.equal(controller.enabled(), !rejectSave);
    assert.equal(nodes.enablePushButton.disabled, !rejectSave);
    assert.equal(calls.includes("unsubscribe"), rejectSave);
    assert.equal(toasts.length, 1);
  }
});

test("browser push registers with VAPID, persists to the authenticated API, and disables server delivery first", async () => {
  const { controller, calls, nodes } = controllerFixture();
  await controller.refresh();
  assert.equal(controller.enabled(), false);
  assert.equal(await controller.enable(), true);
  assert.equal(controller.enabled(), true);
  const options = calls.find((call) => call.userVisibleOnly);
  assert.equal(options.applicationServerKey.length, 65);
  assert.equal(nodes.enablePageNotificationButton.disabled, true, "page notifications should not duplicate server push");
  assert.equal(await controller.disable(), true);
  assert.deepEqual(calls.slice(-2), [{ path: "/api/push/subscription", method: "DELETE" }, "unsubscribe"]);
  assert.equal(controller.enabled(), false);
});

test("a server registration failure removes only the newly created browser subscription", async () => {
  const { controller, calls } = controllerFixture({ rejectSave: true });
  await controller.refresh();
  assert.equal(await controller.enable(), false);
  assert.equal(calls.at(-1), "unsubscribe");
  assert.equal(controller.enabled(), false);
});

test("insecure origins retain page-notification controls without offering background push", async () => {
  const { controller, environment, nodes } = controllerFixture();
  environment.isSecureContext = false;
  await controller.refresh();
  assert.equal(await controller.enable(), false);
  assert.equal(nodes.enablePushButton.disabled, true);
  assert.equal(nodes.enablePageNotificationButton.disabled, false);
  assert.match(nodes.notificationStatus.textContent, /HTTPS/);
});

test("worker push displays notifications with no window, deduplicates and updates visible tasks quietly", async () => {
  const handlers = new Map();
  const shown = [];
  const messages = [];
  let windows = [];
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  runInNewContext(source, { URL, self: { location: { origin: "https://pwa.example" },
    addEventListener: (name, handler) => handlers.set(name, handler),
    clients: { matchAll: async () => windows }, registration: {
      getNotifications: async () => shown.map(({ options }) => ({ data: options.data })),
      showNotification: async (title, options) => shown.push({ title, options }),
    },
  } });
  const notice = { threadId: "task", title: "Codex 任务已完成", body: "打开查看", eventKey: "a".repeat(64) };
  async function push(value) {
    let pending;
    handlers.get("push")({ data: { json: () => value }, waitUntil: (promise) => { pending = promise; } });
    await pending;
  }
  await push(notice);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.data.threadId, "task");
  await push(notice);
  assert.equal(shown.length, 1);
  windows = [{ url: "https://pwa.example/?thread=task", visibilityState: "visible",
    postMessage: (message) => messages.push(message),
  }];
  await push({ ...notice, eventKey: "b".repeat(64) });
  assert.equal(shown.length, 1);
  assert.equal(messages[0].type, "PUSH_TASK_UPDATED");
  windows[0].visibilityState = "hidden";
  await push({ ...notice, eventKey: "b".repeat(64) });
  assert.equal(shown.length, 2);
  await push({ threadId: "x".repeat(1000) });
  assert.equal(shown.length, 2);
});
