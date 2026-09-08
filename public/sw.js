const CACHE = "codex-pwa-v50";
const ASSETS = [
  "/",
  "/styles.css",
  "/app.js",
  "/file-links.js",
  "/file-preview.html",
  "/file-preview.css",
  "/file-preview.js",
  "/history-utils.js",
  "/markdown-math.js",
  "/message-reconcile.js",
  "/upload-utils.js",
  "/storage-utils.js",
  "/virtual-list.js",
  "/model-display.js",
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
