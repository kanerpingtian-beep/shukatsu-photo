const CACHE_NAME = "shukatsu-photo-v7";
const ASSETS = ["./", "./index.html", "./styles.css?v=7", "./app.js?v=7", "./manifest.webmanifest"];

// AIモデル・WASMは内容が変わらないので、一度取得したらキャッシュ優先で返す。
// これで2回目以降はオフラインでもAI背景分離が動く。
const IMMUTABLE_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  if (IMMUTABLE_HOSTS.includes(url.hostname)) {
    // キャッシュ優先（モデル・フォントなどの不変リソース）
    event.respondWith(
      caches.match(event.request).then(cached =>
        cached ||
        fetch(event.request).then(response => {
          if (response.ok || response.type === "opaque") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
      )
    );
    return;
  }

  // 自分のアセットはネットワーク優先＋キャッシュフォールバック
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
