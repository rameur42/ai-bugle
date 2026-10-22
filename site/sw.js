// Service worker: network first (always the latest veille), cache as the offline fallback.
// Every successful same-origin GET is cached, so any veille opened once stays readable offline.
const CACHE = "ai-bugle-v3";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icons/favicon-light.png", "icons/favicon-dark.png", "icons/logo-light.png", "icons/logo-dark.png", "icons/icon-192.png", "veilles/index.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error())),
  );
});
