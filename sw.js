// Service worker：讓看板可以安裝成 App，並在沒網路時仍打得開（顯示上次抓到的資料）。
// 改動前端後把 VERSION 加一，舊的頁面快取才會被換掉。
const VERSION = "v6";
const SHELL = "shell-" + VERSION;

// 資料快取刻意不帶版本號：改前端不該把上次抓到的節目資料一起丟掉，
// 否則版本一升就等於沒有離線資料可用。
const DATA = "data";

const SHELL_FILES = [
  "./", "./index.html", "./manifest.json",
  "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 字型走瀏覽器自己的快取，不要攔
  if (url.origin !== location.origin) return;

  e.respondWith(url.pathname.endsWith("data.json") ? freshData(req) : shell(req));
});

// data.json：優先拿最新的，拿不到才退回上次存的。
//
// ignoreSearch 是必要的——頁面帶了 ?t=... 的 cache buster，那個值每 10 分鐘換一次，
// 不忽略查詢字串就永遠比對不到自己上次存的那一份，離線 fallback 形同虛設。
async function freshData(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(DATA)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: true, cacheName: DATA });
    // 快取也沒有時一定要回傳一個 Response。回 undefined 會讓 respondWith 拋錯，
    // 頁面只會收到意義不明的「Load failed」。
    return hit || new Response(
      JSON.stringify({ offline: true, updated: 0, items: [] }),
      { status: 503, headers: { "Content-Type": "application/json;charset=utf-8" } }
    );
  }
}

// 頁面外殼與圖示：先給快取，同時在背景更新
async function shell(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  const net = fetch(req)
    .then(async res => {
      if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || (await net) || new Response("離線中，且沒有可用的快取。", {
    status: 503, headers: { "Content-Type": "text/plain;charset=utf-8" }
  });
}
