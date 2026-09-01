// Service worker：讓看板可以安裝成 App，並在沒網路時仍打得開（顯示上次抓到的資料）。
// 改版時把 VERSION 加一，舊快取才會被清掉。
const VERSION = "v4";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 字型走瀏覽器自己的快取，不要攔
  if (url.origin !== location.origin) return;

  // data.json 要最新的，拿不到才退回快取——離線時看到的是上次的資料，總比空白好
  if (url.pathname.endsWith("data.json")) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 其餘（頁面外殼、圖示）先給快取，同時在背景更新
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
