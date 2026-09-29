const CACHE_PREFIX = `terre-lontane:${self.registration.scope}:`;
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const APP_FILES = ["./", "./index.html", "./install.js", "./manifest.json", "./icon_low.png", "./icon.png"];
const CDN_FILES = [
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
  "https://cdn.jsdelivr.net/npm/marked/marked.min.js",
  "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js",
];
const appURLs = new Set(APP_FILES.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_FILES);
    // External libraries are optional: a CDN outage must not prevent installation.
    await Promise.allSettled(CDN_FILES.map(async (url) => {
      const response = await fetch(url, { mode: "cors" });
      if (response.ok) await cache.put(url, response);
    }));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Only static application assets are cached. Chat and session APIs use the network.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const appNavigation = request.mode === "navigate" &&
    (url.href.split("?")[0] === self.registration.scope ||
     url.href.split("?")[0] === new URL("index.html", self.registration.scope).href);
  if (!appNavigation && !appURLs.has(url.href) && !CDN_FILES.includes(url.href)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = appNavigation ? new URL("./", self.registration.scope).href : request;
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(cacheKey, response.clone());
      return response;
    } catch {
      const cached = await cache.match(cacheKey);
      return cached || Response.error();
    }
  })());
});
