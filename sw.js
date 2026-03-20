/**
 * MemoriX — sw.js
 * Service Worker: キャッシュ戦略
 *
 * 戦略:
 *   - App Shell (HTML/CSS/JS/フォント) → Cache First
 *   - Firebase API / Firestore          → Network Only（オフライン永続化はFirestoreに任せる）
 *   - 画像                               → Stale While Revalidate
 *   - その他外部リソース                  → Network First with fallback
 */

const CACHE_VERSION  = 'memorix-v1';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const IMAGE_CACHE     = `${CACHE_VERSION}-images`;

// キャッシュするApp Shellリソース
const APP_SHELL_URLS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  // アイコン
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ネットワークのみ（キャッシュしない）URLパターン
const NETWORK_ONLY_PATTERNS = [
  /firestore\.googleapis\.com/,
  /firebasestorage\.googleapis\.com/,
  /identitytoolkit\.googleapis\.com/,
  /firebase\.googleapis\.com/,
  /googleapis\.com\/v1\/projects/,
];

// Stale While Revalidate パターン（画像）
const SWR_PATTERNS = [
  /\.(?:png|jpg|jpeg|gif|webp|svg|ico)$/i,
  /firebasestorage\.googleapis\.com.*\/o\//,
];

// ─────────────────────────────────────────────
// インストール: App Shellをキャッシュ
// ─────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then(async (cache) => {
      try {
        // 個別にキャッシュして1つ失敗しても続行
        await Promise.allSettled(
          APP_SHELL_URLS.map(url =>
            cache.add(url).catch(err => console.warn(`[SW] Cache skip: ${url}`, err))
          )
        );
        console.log('[SW] App Shell cached ✅');
      } catch (err) {
        console.error('[SW] Install error:', err);
      }
    })
  );
  // 即座にアクティベートして待機をスキップ
  self.skipWaiting();
});

// ─────────────────────────────────────────────
// アクティベート: 古いキャッシュを削除
// ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(async (keys) => {
      const toDelete = keys.filter(key =>
        key.startsWith('memorix-') && key !== APP_SHELL_CACHE && key !== IMAGE_CACHE
      );
      await Promise.all(toDelete.map(key => {
        console.log('[SW] Deleting old cache:', key);
        return caches.delete(key);
      }));
    })
  );
  // 全クライアントを即座に制御下に置く
  self.clients.claim();
});

// ─────────────────────────────────────────────
// フェッチ: 戦略ルーティング
// ─────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // POST / PUT / DELETE はキャッシュしない
  if (request.method !== 'GET') return;

  // chrome-extension など非 http(s) はスキップ
  if (!url.protocol.startsWith('http')) return;

  // ① Firebase API → Network Only
  if (NETWORK_ONLY_PATTERNS.some(p => p.test(url.href))) {
    event.respondWith(networkOnly(request));
    return;
  }

  // ② 画像 → Stale While Revalidate
  if (SWR_PATTERNS.some(p => p.test(url.href))) {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE));
    return;
  }

  // ③ App Shell (same origin) → Cache First with network fallback
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, APP_SHELL_CACHE));
    return;
  }

  // ④ CDN外部リソース（Tailwind, Fonts, Firebase SDK）→ Network First
  event.respondWith(networkFirst(request, APP_SHELL_CACHE));
});

// ─────────────────────────────────────────────
// キャッシュ戦略実装
// ─────────────────────────────────────────────

/** Cache First: キャッシュにあればそれを返し、なければネットワーク取得してキャッシュ */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // オフラインでキャッシュもない場合: index.htmlへフォールバック
    const fallback = await caches.match('./index.html');
    return fallback || new Response('オフライン中です', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/** Network First: ネットワーク優先、失敗したらキャッシュ */
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('', { status: 503 });
  }
}

/** Network Only: キャッシュせず常にネットワーク（Firebase APIで使用） */
async function networkOnly(request) {
  return fetch(request);
}

/**
 * Stale While Revalidate:
 * キャッシュがあれば即返し、バックグラウンドで更新（画像に最適）
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || fetchPromise || new Response('', { status: 503 });
}

// ─────────────────────────────────────────────
// バックグラウンド同期（Phase 5向けスタブ）
// オフライン中の学習記録を再接続時に同期する設計
// ─────────────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-study-records') {
    // TODO: Phase 5 — IndexedDBから未同期レコードをFirestoreに書き込む
    console.log('[SW] Background sync: sync-study-records');
  }
});

// ─────────────────────────────────────────────
// プッシュ通知（Phase 5向けスタブ）
// 復習リマインダー通知の受信処理
// ─────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  // TODO: Phase 5 — 忘却曲線に基づく復習リマインダー
  event.waitUntil(
    self.registration.showNotification(data.title || 'MemoriX', {
      body:  data.body  || '今日の復習をしましょう！',
      icon:  './icons/icon-192.png',
      badge: './icons/icon-72.png',
      tag:   'memorix-review-reminder',
      data:  { url: './#review' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.navigate(targetUrl);
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

console.log('[SW] Service Worker loaded 🛡️');
