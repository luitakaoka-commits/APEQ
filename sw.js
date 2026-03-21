/**
 * 過去問研究 — sw.js
 * キャッシュ戦略:
 *   同一オリジン (HTML/JS)  → Cache First
 *   Firebase API            → Network Only（オフライン永続化はFirestoreに委任）
 *   画像 / Storage          → Stale While Revalidate
 *   CDN外部リソース          → Network First
 */

const VER          = 'kakomon-v1';
const SHELL_CACHE  = `${VER}-shell`;
const IMAGE_CACHE  = `${VER}-images`;

const SHELL_URLS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const NET_ONLY = [
  /firestore\.googleapis\.com/,
  /firebasestorage\.googleapis\.com/,
  /identitytoolkit\.googleapis\.com/,
  /firebase\.googleapis\.com/,
];

const SWR_PATTERNS = [
  /\.(?:png|jpg|jpeg|gif|webp|svg|ico)$/i,
  /firebasestorage\.googleapis\.com.*\/o\//,
];

// ─── Install ───
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(cache =>
      Promise.allSettled(SHELL_URLS.map(u => cache.add(u).catch(() => {})))
    )
  );
  self.skipWaiting();
});

// ─── Activate ───
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k.startsWith('kakomon-') && k !== SHELL_CACHE && k !== IMAGE_CACHE)
        .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch ───
self.addEventListener('fetch', e => {
  const { request: req } = e;
  if (req.method !== 'GET') return;
  if (!req.url.startsWith('http')) return;

  const url = req.url;

  if (NET_ONLY.some(p => p.test(url)))  { e.respondWith(fetch(req)); return; }
  if (SWR_PATTERNS.some(p => p.test(url))) { e.respondWith(swr(req)); return; }
  if (new URL(url).origin === self.location.origin) { e.respondWith(cacheFirst(req)); return; }
  e.respondWith(netFirst(req));
});

async function cacheFirst(req) {
  const c = await caches.match(req);
  if (c) return c;
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL_CACHE)).put(req, res.clone());
    return res;
  } catch {
    return (await caches.match('./index.html'))
      || new Response('オフライン中です', { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
  }
}

async function netFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL_CACHE)).put(req, res.clone());
    return res;
  } catch {
    return (await caches.match(req)) || new Response('', { status: 503 });
  }
}

async function swr(req) {
  const cache   = await caches.open(IMAGE_CACHE);
  const cached  = await cache.match(req);
  const fetchP  = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return cached || fetchP || new Response('', { status: 503 });
}

// ─── Background Sync スタブ（Phase 5） ───
self.addEventListener('sync', e => {
  if (e.tag === 'sync-reviews') {
    // TODO: Phase 5 — オフライン中の学習記録を再接続時にFirestoreへ同期
  }
});

// ─── Push 通知スタブ（Phase 5） ───
self.addEventListener('push', e => {
  if (!e.data) return;
  const d = e.data.json();
  e.waitUntil(self.registration.showNotification(d.title || '過去問研究', {
    body:  d.body  || '今日の復習をしましょう！',
    icon:  './icons/icon-192.png',
    badge: './icons/icon-72.png',
    tag:   'kakomon-reminder',
    data:  { url: './#review' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || './';
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(ws => {
      for (const w of ws) {
        if (w.url.includes(self.location.origin)) { w.focus(); w.navigate(url); return; }
      }
      return clients.openWindow(url);
    })
  );
});
