/*
 * Nyora Web — service worker. Makes the app installable + offline-capable.
 *
 * Strategy:
 *   - app shell (html/css/js modules, icon)  -> stale-while-revalidate, precached
 *   - parser engine (web-parsers/*.js + sources.json) -> stale-while-revalidate
 *   - proxied cover/page images               -> cache-first (immutable-ish)
 *   - everything else / API                   -> network-first, cache fallback
 */
const VERSION = 'nyora-v24';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const IMAGES = `${VERSION}-img`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/env.js',
  '/app.js',
  '/icon.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {})).then(() => self.skipWaiting()),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
}

function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => cached || fetch(request).then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })),
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Same-origin image proxy -> cache-first (covers and chapter pages are immutable-ish).
  if (sameOrigin && url.pathname === '/image') {
    event.respondWith(cacheFirst(request, IMAGES));
    return;
  }

  // Cross-origin: pass through (proxy HTML fetches, etc.).
  if (!sameOrigin) return;

  // App shell navigations -> shell cache, fall back to index for SPA routes.
  if (request.mode === 'navigate') {
    event.respondWith(
      staleWhileRevalidate(request, SHELL).catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Static app + parser engine -> stale-while-revalidate.
  if (/\.(?:js|css|json|webmanifest|png|svg|woff2?)$/.test(url.pathname) || url.pathname === '/') {
    event.respondWith(staleWhileRevalidate(request, RUNTIME));
    return;
  }

  // Everything else (same-origin API) -> network-first.
  event.respondWith(
    fetch(request).then((res) => {
      if (res && res.ok) caches.open(RUNTIME).then((c) => c.put(request, res.clone()));
      return res;
    }).catch(() => caches.match(request)),
  );
});
