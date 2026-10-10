/*
 * Nyora Web — service worker. Makes the app installable + offline-capable.
 *
 * Strategy:
 *   - app shell (html/css/js modules, icon)  -> stale-while-revalidate, precached
 *   - static app modules (js/css/json)        -> stale-while-revalidate
 *   - proxied cover/page images               -> cache-first for 24 hours, offline fallback
 *   - everything else / API                   -> network-first, cache fallback
 */
const VERSION = 'nyora-v2.6.0';
// Local dev serves web/ unbundled — stale-while-revalidate would keep the
// browser one edit behind forever. Bypass the code caches on localhost.
// "Dev" = not one of the production hosts. Covers localhost AND accessing the
// dev server from a phone over the LAN (192.168.x / 10.x / 172.16-31.x / *.local
// / raw IP), where stale-while-revalidate would otherwise serve one-reload-old
// code. Only the real deployed domains keep the aggressive caching.
const PROD_HOSTS = /(?:^|\.)(?:nyora\.xyz|nyoraweb\.pages\.dev|nyoramanga\.hasanraza\.tech)$/;
const DEV = !PROD_HOSTS.test(self.location.hostname);
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const IMAGES = `${VERSION}-img`;
const API = `${VERSION}-api`;

// Helper-API hosts (page lists, chapter lists, details). Caching their GET
// responses network-first lets a previously-opened chapter reopen offline.
const API_HOST = /(?:^|\.)nyora\.xyz$/;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/desktop.css',
  '/fonts/poppins-semibold.ttf',
  '/env.js',
  '/boot/migrate.js',
  '/boot/theme.js',
  '/app.js',
  '/core/motion.js',
  '/vendor/gsap.min.js',
  '/icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {})).then(() => self.skipWaiting()),
  );
  self.skipWaiting();
});

// Caches that must SURVIVE service-worker upgrades. The AI-translation models
// (~125 MB) live in 'nyora-tl-models' — wiping it on every version bump forces
// users to re-download the models after each deploy.
const PERSISTENT_CACHES = new Set(['nyora-tl-models']);

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION) && !PERSISTENT_CACHES.has(k)).map((k) => caches.delete(k)),
      ))
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

// Track age separately so opaque CDN responses remain usable offline. Legacy
// images without timestamps refresh once online; no source clears another's data.
const IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
async function cacheFirstImage(request, cacheName) {
  const cache = await caches.open(cacheName);
  const ages = await caches.open(`${cacheName}-age`);
  const cached = await cache.match(request);
  const stamp = await ages.match(request);
  const fetchedAt = stamp ? Number(await stamp.text()) : 0;
  const age = Date.now() - fetchedAt;
  if (cached && fetchedAt > 0 && age >= 0 && age < IMAGE_MAX_AGE_MS) return cached;

  // Previous releases advertised helper images as immutable for a year. A daily
  // helper cache key bypasses those objects without altering signed source URLs.
  const url = new URL(request.url);
  if (url.pathname === '/image' &&
      (url.origin === self.location.origin || API_HOST.test(url.hostname))) {
    url.searchParams.set('nyora_image_day', String(Math.floor(Date.now() / IMAGE_MAX_AGE_MS)));
  }
  const refresh = new Request(new Request(url, request), { cache: 'reload' });
  try {
    const response = await fetch(coiSafe(refresh));
    if (response && (response.status === 200 || response.type === 'opaque')) {
      // Storage failures must not turn a successful network load into an error.
      try {
        await cache.put(request, response.clone());
        await ages.put(request, new Response(String(Date.now())));
      } catch { /* cache storage may be unavailable/full */ }
      return response;
    }
    if (cached) return cached;
    throw new Error('Image response is unavailable or incomplete');
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

// Under COEP:credentialless (see withCoi below) an opaque response relayed by
// this SW only passes the embedder check if its request carried no credentials.
// Manga CDNs don't use cookies, so re-issue cross-origin image fetches
// credential-free; without this, every direct-CDN page image breaks the moment
// the app becomes cross-origin isolated.
function coiSafe(request) {
  try {
    return new Request(request, { credentials: 'omit' });
  } catch {
    return request;
  }
}

// Network-first with cache fallback — fresh when online, last-seen when offline.
function networkFirst(request, cacheName) {
  return caches.open(cacheName).then((cache) =>
    fetch(request).then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    }).catch(() => cache.match(request)),
  );
}

// --- cross-origin isolation (multi-threaded wasm) --------------------------
// Inject COOP/COEP on same-origin documents and scripts so the app becomes
// crossOriginIsolated — onnxruntime's wasm backend can then use SharedArrayBuffer
// worker threads and the on-device translator gets real multi-core speed.
// COEP:credentialless keeps no-cors CDN page images loading (they're fetched
// without credentials, which manga CDNs don't need); browsers that don't know
// the value fall back to unisolated single-thread — nothing breaks.
function withCoi(res) {
  if (!res || res.status === 0 || (res.status >= 300 && res.status < 400)) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
const coi = (p) => p.then(withCoi);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Same-origin image proxy uses the same per-image daily refresh as remote sources.
  if (sameOrigin && url.pathname === '/image') {
    event.respondWith(cacheFirstImage(request, IMAGES));
    return;
  }

  // Cross-origin: cache what makes chapters readable offline.
  if (!sameOrigin) {
    // Page & cover images straight from source / AniList CDNs.
    if (request.destination === 'image') { event.respondWith(cacheFirstImage(request, IMAGES)); return; }
    // Helper API (page lists, chapter lists, details) → network-first, offline fallback.
    if (API_HOST.test(url.hostname)) { event.respondWith(networkFirst(request, API)); return; }
    return; // everything else passes through
  }

  // Dev: always-fresh code, offline fallback only; COI headers still applied
  // so wasm threads work locally too. `cache: 'no-store' ` bypasses the BROWSER's
  // HTTP cache as well — plain fetch(request) still served stale unversioned
  // modules (e.g. /screens/*.js) from disk cache, leaving dev one edit behind.
  if (DEV) {
    let req = request;
    try { req = new Request(request, { cache: 'no-store' }); } catch { /* keep original if not re-constructable */ }
    event.respondWith(coi(fetch(req).catch(() => caches.match(request))));
    return;
  }

  // App shell navigations -> shell cache, fall back to index for SPA routes.
  if (request.mode === 'navigate') {
    event.respondWith(
      coi(staleWhileRevalidate(request, SHELL).catch(() => caches.match('/index.html'))),
    );
    return;
  }

  // Static app modules -> stale-while-revalidate.
  if (/\.(?:m?js|css|json|webmanifest|png|svg|ico|woff2?)$/.test(url.pathname) || url.pathname === '/') {
    event.respondWith(coi(staleWhileRevalidate(request, RUNTIME)));
    return;
  }

  // Everything else (same-origin API) -> network-first.
  event.respondWith(
    fetch(request).then((res) => {
      // Clone SYNCHRONOUSLY (before returning), or the async caches.open() below
      // runs after the browser has started consuming res.body → clone() throws
      // "Response body is already used".
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(RUNTIME).then((c) => c.put(request, copy));
      }
      return res;
    }).catch(() => caches.match(request)),
  );
});
