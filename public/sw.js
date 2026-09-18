const CACHE = "codex-pwa-v121";
const ASSETS = [
  "/",
  "/styles.css",
  "/app.js",
  "/ui-copy.js",
  "/diagnostics-view.js",
  "/notification-handler.js",
  "/api-client.js",
  "/file-links.js",
  "/file-preview.html",
  "/file-preview.css",
  "/file-preview.js",
  "/history-utils.js",
  "/markdown-math.js",
  "/message-reconcile.js",
  "/upload-utils.js",
  "/storage-utils.js",
  "/event-session.js",
  "/virtual-list.js",
  "/model-display.js",
  "/task-snapshot.js",
  "/status-display.js",
  "/browser-notifications.js",
  "/push-notifications.js",
  "/notification-diagnostics.js",
  "/notification-methods.js",
  "/approval-policy.js",
  "/thread-view-state.js",
  "/message-display.js",
  "/message-outline.js",
  "/dialog-focus.js",
  "/dom-reconcile.js",
  "/navigation-panels.js",
  "/status-announcer.js",
  "/tab-navigation.js",
  "/event-connection.js",
  "/goal-actions.js",
  "/history-nodes.js",
  "/history-context.js",
  "/message-view.js",
  "/directory-browser.js",
  "/file-browser.js",
  "/activity-view.js",
  "/thread-api.js",
  "/thread-list-view.js",
  "/time-display.js",
  "/thread-list.js",
  "/markdown-renderer.js",
  "/device-manager.js",
  "/access-roots.js",
  "/thread-actions.js",
  "/approval-actions.js",
  "/approval-decisions.js",
  "/approval-state.js",
  "/task-settings.js",
  "/task-composer.js",
  "/write-request.js",
  "/message-time.js",
  "/vendor/marked/marked.esm.js",
  "/vendor/dompurify/purify.es.mjs",
  "/vendor/katex/katex.mjs",
  "/vendor/katex/katex.min.css",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon.svg?v=27",
  "/icon-192.png",
  "/icon-192.png?v=27",
  "/icon-512.png",
];
const ASSET_PATHS = new Set(ASSETS.map((asset) => new URL(asset, self.location.origin).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const threadId = event.notification.data?.threadId;
  if (typeof threadId !== "string" || !threadId || threadId.length > 160) return;
  event.waitUntil((async () => {
    // Construct the route locally; notification payloads never choose an origin.
    const destination = new URL("/", self.location.origin);
    destination.searchParams.set("thread", threadId);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const candidates = windows.filter((client) => {
      const url = new URL(client.url);
      return url.origin === destination.origin && (url.pathname === "/" || url.pathname === "/index.html");
    });
    const client = candidates.find((item) => new URL(item.url).searchParams.get("thread") === threadId)
      || candidates.find((item) => item.focused) || candidates[0];
    if (client) {
      try {
        await client.focus();
        client.postMessage({ type: "OPEN_NOTIFICATION_THREAD", threadId });
        return;
      } catch {}
    }
    await self.clients.openWindow(destination.href);
  })());
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let notice;
    try { notice = event.data?.json(); } catch { return; }
    if (typeof notice?.threadId !== "string" || !notice.threadId || notice.threadId.length > 160) return;
    const threadId = notice.threadId;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    let viewing = false;
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin !== self.location.origin || !["/", "/index.html"].includes(url.pathname)) continue;
      client.postMessage({ type: "PUSH_TASK_UPDATED", threadId });
      if (client.visibilityState === "visible" && url.searchParams.get("thread") === threadId) viewing = true;
    }
    if (viewing) return;
    const tag = `codex-pwa-${threadId}`;
    const eventKey = /^[a-f0-9]{64}$/.test(notice.eventKey || "") ? notice.eventKey : null;
    if (eventKey && (await self.registration.getNotifications({ tag })).some((item) => item.data?.eventKey === eventKey)) return;
    await self.registration.showNotification(String(notice.title || "Codex 任务有更新").slice(0, 100), {
      body: String(notice.body || "打开任务查看最新状态").slice(0, 240), tag,
      icon: "/icon-192.png", data: { threadId, eventKey },
    });
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const navigation = event.request.mode === "navigate";
  if (
    event.request.method !== "GET"
    || url.origin !== self.location.origin
    || url.pathname.startsWith("/api/")
    || (!navigation && !ASSET_PATHS.has(url.pathname))
  ) return;
  const cacheKey = navigation && url.pathname !== "/file-preview.html" ? "/" : url.pathname;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(cacheKey, copy));
        }
        return response;
      })
      .catch(() => caches.match(cacheKey).then((cached) => cached || Response.error())),
  );
});
