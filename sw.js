/* WX BRF Service Worker
   - アプリ本体(シェル)はインストール時にキャッシュ → 機内モードでも起動
   - 気象データ(一覧JSON・図・PDF)は「ネット優先、失敗したら前回分」。前回分には x-wx-offline: 1 を付けて返す
   - 地図タイル(時刻入りURLなので中身が変わらない)はキャッシュ優先
   ※ index.html 等を更新したら VER を上げる(index.html の VER_TAG・BUILD も一緒に) */
const VER = 'wxbrf-p1-4';
const DATA_CACHE = 'wxbrf-data';
const TILE_CACHE = 'wxbrf-tiles';
const TILE_MAX = 3000;
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/';

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './sources.json',
  './japan.json',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  PDFJS + 'pdf.min.mjs',
  PDFJS + 'pdf.worker.min.mjs'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== VER && k !== DATA_CACHE && k !== TILE_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isTile(url) {
  if (url.host === 'cyberjapandata.gsi.go.jp') return true;
  /* 気象庁のタイル: …/surf/{要素}/{z}/{x}/{y}.png、ひまわり …/{バンド}/{z}/{x}/{y}.jpg */
  return url.host === 'www.jma.go.jp' && /\/\d+\/\d+\/\d+\.(png|jpg|pbf)$/.test(url.pathname);
}
function isData(url) {
  return url.host === 'www.jma.go.jp' || url.host === 'www.data.jma.go.jp';
}

async function trimTiles() {
  try {
    const c = await caches.open(TILE_CACHE);
    const keys = await c.keys();
    if (keys.length > TILE_MAX) for (let i = 0; i < 300 && i < keys.length; i++) await c.delete(keys[i]);
  } catch (err) {}
}

/* 取得時刻を x-wx-fetched に入れて保存し、オフライン時に「いつの分か」を画面に出せるようにする */
async function putStamped(cacheName, req, res) {
  const body = await res.clone().blob();
  const h = new Headers(res.headers);
  h.set('x-wx-fetched', new Date().toISOString());
  const c = await caches.open(cacheName);
  await c.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers: h }));
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) putStamped(DATA_CACHE, req, res).catch(() => {});
    return res;
  } catch (err) {
    const hit = await caches.match(req, { cacheName: DATA_CACHE, ignoreVary: true });
    if (!hit) throw err;
    const h = new Headers(hit.headers);
    h.set('x-wx-offline', '1');
    return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers: h });
  }
}

async function cacheFirst(req, cacheName) {
  const hit = await caches.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') {
    const c = await caches.open(cacheName);
    c.put(req, res.clone()).then(() => cacheName === TILE_CACHE && trimTiles()).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTile(url)) { e.respondWith(cacheFirst(req, TILE_CACHE)); return; }
  if (isData(url)) { e.respondWith(networkFirst(req)); return; }
  /* sources.json はURL修正をすぐ届けたいのでネット優先 */
  if (url.origin === location.origin && url.pathname.endsWith('/sources.json')) {
    e.respondWith(fetch(req).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }
  if (url.host === 'cdnjs.cloudflare.com' || url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, VER)); return;
  }
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
  }
});
