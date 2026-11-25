// Caches the whole app (including the face model) so it still works if Wi-Fi drops overnight.
const CACHE = "wakeface-v1";
const FILES = [
  "./", "index.html", "app.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png",
  "vendor/vision_bundle.mjs", "vendor/face_landmarker.task",
  "vendor/wasm/vision_wasm_internal.js", "vendor/wasm/vision_wasm_internal.wasm",
  "vendor/wasm/vision_wasm_nosimd_internal.js", "vendor/wasm/vision_wasm_nosimd_internal.wasm",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // Network first so updates arrive; cache when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
