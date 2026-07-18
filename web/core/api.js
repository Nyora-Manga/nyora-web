// core/api.js — REST client for the Nyora web SPA.
//
// The shared, read-only catalog (catalog/popular/latest/search/details/pages
// + the /image proxy) is served by the hosted parser helper at
// NYORA_HELPER_URL (https://api.nyora.xyz). Those calls hit the helper
// FIRST and fall back to the in-browser web parsers (core/parser-runtime.js)
// only when the helper is unreachable. Every method returns parsed JSON and
// THROWS Error(data.error || status) on failure.
//
// Endpoint verbs/params verified against:
//   nyora-mac/shared/src/jvmMain/kotlin/com/nyora/shared/proxy/NyoraRestServer.kt
//
// Mutations use QUERY-STRING params (not JSON body) EXCEPT /backup/import
// (raw JSON body) and /sync/signin (JSON {email,password} body).
//
// PERSONAL state (favourites/history/bookmarks/categories/prefs/updates/stats/
// backup) is now PER-CLIENT: it lives in the browser via core/library.js
// (localStorage), so each visitor is isolated. Those methods delegate to
// `library` and wrap the plain return value in Promise.resolve(...) so existing
// `await api.foo()` call-sites keep working. The SHARED, read-only catalog
// (sources/browse/details/pages/image/search/local/downloads/network/
// suggestions/alternatives/anilist/sync) stays server-backed and unchanged.

import { library } from './library.js';
import * as parserRuntime from './parser-runtime.js';
import downloadManager from './downloads.js';
import { BLOCKED_SOURCE_IDS } from './blocked-sources.js';

// ---- low-level helpers -------------------------------------------------

function parserRoute(path) {
  const route = String(path || '').split('?')[0];
  return route === '/health' ||
    route === '/sources' ||
    route.startsWith('/sources/') ||
    route.startsWith('/manga/') ||
    route === '/search/global' ||
    route === '/suggestions' ||
    route.startsWith('/downloads') ||
    route === '/settings/network';
}

async function parserGet(path) {
  if (!parserRoute(path)) return null;
  try {
    return await parserRuntime.handle(path, 'GET');
  } catch (e) {
    if (String(e && e.message || '').toLowerCase().includes('not implemented')) return null;
    throw e;
  }
}

async function parserPost(path, body) {
  if (!parserRoute(path)) return null;
  try {
    return await parserRuntime.handle(path, 'POST', body);
  } catch (e) {
    if (String(e && e.message || '').toLowerCase().includes('not implemented')) return null;
    throw e;
  }
}

async function parserDelete(path) {
  if (!parserRoute(path)) return null;
  try {
    return await parserRuntime.handle(path, 'DELETE');
  } catch (e) {
    if (String(e && e.message || '').toLowerCase().includes('not implemented')) return null;
    throw e;
  }
}

/** Build a "?a=b&c=d" string from a plain object, skipping null/undefined. */
function qs(params) {
  if (!params) return '';
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/** Parse a Response into JSON (tolerating empty/non-JSON bodies). */
async function parseBody(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON success (shouldn't happen for these endpoints) — wrap it.
    return { raw: text };
  }
}

/** Throw a useful Error if the response failed or carries an {error}. */
function ensureOk(res, data) {
  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (data && typeof data === 'object' && data.error) {
    throw new Error(data.error);
  }
  return data;
}

// ---- hosted helper (api.hasanraza.tech) --------------------------------
// Absolute base of the hosted parser helper, trailing slash trimmed.
function helperBase() {
  const u = globalThis.NYORA_HELPER_URL || 'https://api.nyora.xyz';
  return String(u).replace(/\/+$/, '');
}

// Client-side load balancing across helper nodes for the JSON API (browse/search/
// details/pages). Configure globalThis.NYORA_HELPER_URLS = ['https://api.nyora.xyz',
// 'https://<owner>-<space>.hf.space', …]; with a single entry this is a no-op and
// behaves exactly like helperBase(). List a node more than once to weight it lower.
//
// IMAGES intentionally stay on helperBase() (the primary VM cluster) — a lean node
// without WARP can't fetch some CDNs, so routing covers through it would break them.
function apiBases() {
  const list = globalThis.NYORA_HELPER_URLS;
  if (Array.isArray(list) && list.length) return list.map((u) => String(u).replace(/\/+$/, ''));
  return [helperBase()];
}

let _apiRR = 0;
// Nodes to try for one request: a rotating primary followed by the rest as failover.
function apiTryOrder() {
  const bases = apiBases();
  if (bases.length < 2) return bases;
  const start = _apiRR++ % bases.length;
  return bases.slice(start).concat(bases.slice(0, start));
}

// fetch a helper route, trying each node in rotation. Falls over to the next node
// on a network error or a gateway status (502/503/504) — a sleeping/overloaded node
// transparently defers to a healthy one. Real 4xx and parsed {error} pass through.
async function helperFetch(path, init) {
  const order = apiTryOrder();
  let lastErr;
  for (let i = 0; i < order.length; i++) {
    try {
      const res = await fetch(order[i] + helperPath(path), init);
      if (i < order.length - 1 && (res.status === 502 || res.status === 503 || res.status === 504)) {
        lastErr = new Error('HTTP ' + res.status);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err; // network failure → try the next node
    }
  }
  throw lastErr || new Error('all helper nodes unreachable');
}

// Given a proxied "…/image?u=<encoded-cdn-url>" URL, derive a { Referer } of the
// image's own origin. Hotlink/Cloudflare-protected CDNs (e.g. AnisaScans) 403 a
// refererless fetch, which makes the helper's /image return 502 (blank cover).
function refererFromProxied(proxyUrl) {
  try {
    const m = /[?&]u=([^&]+)/.exec(proxyUrl);
    if (!m) return null;
    const origin = new URL(decodeURIComponent(m[1])).origin;
    return { Referer: origin + '/' };
  } catch { return null; }
}

// Map the SPA's internal route names onto the helper's REAL route names. The
// helper serves manga detail/page reads under /manga/details and /manga/pages
// (NOT /sources/details — that prefix-matches the bare /sources context and
// wrongly returns the source list, which broke "open manga").
function helperPath(path) {
  const idx = String(path).indexOf('?');
  const route = idx === -1 ? String(path) : String(path).slice(0, idx);
  const query = idx === -1 ? '' : String(path).slice(idx);
  let r = route;
  if (r === '/sources/details' || r === '/manga/details') r = '/manga/details';
  else if (r === '/sources/pages' || r === '/manga/pages') r = '/manga/pages';
  return r + query;
}

// GET routes served by the hosted helper (the shared, read-only catalog).
function helperGetRoute(path) {
  const route = String(path || '').split('?')[0];
  return route === '/sources/catalog' ||
    route === '/sources/popular' ||
    route === '/sources/latest' ||
    route === '/sources/search' ||
    route === '/sources/details' ||
    route === '/sources/pages' ||
    route === '/manga/details' ||
    route === '/manga/pages';
}

async function helperGet(path) {
  const res = await helperFetch(path, { headers: { Accept: 'application/json' } });
  const data = await parseBody(res);
  return ensureOk(res, data);
}

async function helperPost(path, body) {
  const init = { method: 'POST', headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await helperFetch(path, init);
  const data = await parseBody(res);
  return ensureOk(res, data);
}

export async function get(path) {
  // Content (catalog/browse/details/pages) is served ONLY by the hosted helper
  // (api.hasanraza.tech). The old in-browser web-parsers are NOT used as a
  // fallback anymore — that path hit a dead CORS-proxy worker and surfaced the
  // wrong sources. A helper failure surfaces as a clean error to the UI.
  if (helperGetRoute(path)) {
    return await helperGet(path);
  }
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  const data = await parseBody(res);
  return ensureOk(res, data);
}

export async function post(path, body) {
  const route = String(path || '').split('?')[0];
  // Source install: the local source prefs stay authoritative for the Explore
  // UI + client-side parser fallback, so run the local mutation; also notify
  // the hosted helper best-effort so a server-side install is registered.
  if (route === '/sources/install') helperPost(path, body).catch(() => {});
  const parserResult = await parserPost(path, body);
  if (parserResult) return parserResult;
  const init = { method: 'POST', headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const data = await parseBody(res);
  return ensureOk(res, data);
}

export async function del(path) {
  const parserResult = await parserDelete(path);
  if (parserResult) return parserResult;
  const res = await fetch(path, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  const data = await parseBody(res);
  return ensureOk(res, data);
}


// ---- installed sources (new-API model) ---------------------------------
// The Explore grid + search operate on the user's OWN installed set (kept in
// localStorage, per visitor), resolved against the hosted helper's catalog
// (api.hasanraza.tech /sources/catalog). This replaces the old client-side
// web-parser list. Installing a source adds its id here AND registers it on
// the helper so browse/search work.
// v3: default = ALL extensions enabled. When there is NO saved set, every catalog
// source is treated as installed (Explore shows them all, no manual install step).
// The saved set only exists once the user customizes it (install/uninstall), after
// which their choices stick. Bumped v2→v3 so existing users pick up the new default.
const INSTALLED_KEY = 'nyora.sources.installed.v3';

/** The user's explicit saved set, or null if they haven't customized (→ all enabled). */
function savedInstalledIds() {
  try {
    const raw = localStorage.getItem(INSTALLED_KEY);
    if (raw == null) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}
function saveInstalledIds(ids) {
  try { localStorage.setItem(INSTALLED_KEY, JSON.stringify([...new Set(ids)])); } catch { /* ignore */ }
}

// Pinned sources (per-visitor). Global search restricts to pinned when any exist,
// otherwise searches all installed. Kept client-side like the installed set.
const PINNED_KEY = 'nyora.sources.pinned.v1';
function pinnedIds() {
  try { const a = JSON.parse(localStorage.getItem(PINNED_KEY)); return Array.isArray(a) ? a : []; } catch { return []; }
}
function savePinnedIds(ids) {
  try { localStorage.setItem(PINNED_KEY, JSON.stringify([...new Set(ids)])); } catch { /* ignore */ }
}

/** Effective installed ids: the saved set, or ALL catalog ids by default. */
async function currentInstalledIds() {
  const saved = savedInstalledIds();
  if (saved != null) return saved;
  return (await fetchCatalog()).map((e) => e.id); // default: all enabled
}

// The catalog exposes contentType but not always an isNsfw flag; treat adult
// (Hentai) content types as NSFW so the "Show 18+ sources" filter works.
function isNsfwSource(e) {
  return e.isNsfw === true || /hentai|adult|nsfw|18\+/i.test(String(e.contentType || ''));
}

let _catalogCache = null;
let _nsfwIds = null;   // Set of source ids flagged adult — for the history guard
async function fetchCatalog() {
  if (_catalogCache) return _catalogCache;
  const res = await get('/sources/catalog'); // hosted helper (static snapshot)
  const list = (res && (res.entries || res.sources)) || (Array.isArray(res) ? res : []);
  // Hide sources that a live health-check found dead / Cloudflare-blocked
  // (see core/blocked-sources.js) so users only ever see working sources.
  const filtered = (Array.isArray(list) ? list : []).filter((e) => !BLOCKED_SOURCE_IDS.has(e.id));
  _catalogCache = filtered;
  _nsfwIds = new Set(_catalogCache.filter(isNsfwSource).map((e) => e.id));
  return _catalogCache;
}

// ---- the api surface ---------------------------------------------------

export const api = {
  // expose the low-level helpers too
  get,
  post,
  del,

  // -- Sources ----------------------------------------------------------
  // The Explore grid: the user's installed sources, resolved from the hosted
  // catalog (NOT the old client-side web-parsers).
  async listSources() {
    const [catalog, ids] = [await fetchCatalog(), await currentInstalledIds()];
    const byId = new Map(catalog.map((e) => [e.id, e]));
    const pinned = new Set(pinnedIds());
    const sources = ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((e) => ({ ...e, isInstalled: true, isNsfw: isNsfwSource(e), isPinned: pinned.has(e.id) }));
    return { sources };
  },
  refreshSources() {
    _catalogCache = null;
    _nsfwIds = null;
    return Promise.resolve({ ok: true });
  },
  /** Sync: is this source flagged adult? Best-effort — populated once the catalog
   *  has loaded (it has by the time you reach a reader from Explore/Discover). */
  isSourceNsfw(id) {
    return !!(_nsfwIds && _nsfwIds.has(id));
  },
  // The catalog dialog: the full hosted catalog with isInstalled overlaid from
  // the effective installed set (all by default).
  async catalog() {
    const [catalog, ids] = [await fetchCatalog(), new Set(await currentInstalledIds())];
    return { entries: catalog.map((e) => ({ ...e, isInstalled: ids.has(e.id), isNsfw: isNsfwSource(e) })) };
  },
  async installSource(id) {
    const ids = await currentInstalledIds(); // materialize (all-by-default) then add
    if (!ids.includes(id)) ids.push(id);
    saveInstalledIds(ids);
    // Register on the helper so popular/latest/search/details work for it.
    try { await helperPost('/sources/install' + qs({ id })); } catch { /* best-effort */ }
    return { ok: true };
  },
  async uninstallSource(id) {
    const ids = await currentInstalledIds(); // materialize (all-by-default) then remove
    saveInstalledIds(ids.filter((x) => x !== id));
    try { await helperPost('/sources/uninstall' + qs({ id })); } catch { /* best-effort */ }
    return { ok: true };
  },
  // Replace the whole installed set in one shot (used by onboarding to seed the
  // sources that match the user's chosen languages / 18+ preference). No per-id
  // helper POSTs — the helper serves any catalog id by id, so registering the
  // local set is enough; this keeps onboarding from firing hundreds of requests.
  setInstalledSources(ids) {
    saveInstalledIds(Array.isArray(ids) ? ids : []);
    return Promise.resolve({ ok: true });
  },
  pinSource(id, pinned) {
    // Persist the pin locally (per-visitor); best-effort notify the helper.
    const set = new Set(pinnedIds());
    if (pinned) set.add(id); else set.delete(id);
    savePinnedIds([...set]);
    try { helperPost('/sources/pin' + qs({ id, pinned })); } catch { /* best-effort */ }
    return Promise.resolve({ ok: true });
  },
  sourceFilters(id) {
    return get('/sources/filters' + qs({ id }));
  },

  // -- Browse -----------------------------------------------------------
  popular(sid, page = 1) {
    return get('/sources/popular' + qs({ id: sid, page }));
  },
  latest(sid, page = 1) {
    return get('/sources/latest' + qs({ id: sid, page }));
  },
  // `filters` (optional) = array of filter objects, sent URL-encoded as `f`.
  search(sid, q, page = 1, filters) {
    const f = filters && filters.length ? JSON.stringify(filters) : undefined;
    return get('/sources/search' + qs({ id: sid, q, page, f }));
  },

  // -- Manga ------------------------------------------------------------
  // Served by the hosted helper as /sources/details and /sources/pages.
  details(sid, url) {
    return get('/sources/details' + qs({ id: sid, url }));
  },
  pages(sid, chapterUrl, refresh) {
    return get('/sources/pages' + qs({ id: sid, url: chapterUrl, refresh: refresh ? 1 : undefined }));
  },

  // -- Image proxy ------------------------------------------------------
  // Build a hosted-helper proxy URL "<helper>/image?u=<enc>&h=<enc k:v>...".
  // Pass-through unchanged for same-origin ("/...") or inline (data:/blob:) URLs.
  imageUrl(url, headers) {
    if (!url) return '';
    if (url.startsWith('/') || url.startsWith('data:') || url.startsWith('blob:')) return url;
    // The helper emits cover/page URLs already proxied via its OWN loopback host
    // (http://127.0.0.1:8788/image?u=…). Repoint those at the public helper host
    // instead of double-wrapping them (which browsers can't load from localhost).
    const px = url.indexOf('/image?u=');
    if (px !== -1) {
      let repointed = helperBase() + url.slice(px);
      // The loopback proxy URL drops the source Referer that hotlink/Cloudflare-
      // protected CDNs require — without it the helper's fetch 403s and /image
      // returns 502 (blank cover). Re-add it: caller's header, else derive from
      // the image's own origin.
      if (!repointed.includes('&h=')) {
        const hdrs = (headers && typeof headers === 'object' && Object.keys(headers).length)
          ? headers : refererFromProxied(repointed);
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) {
            repointed += `&h=${encodeURIComponent(k + ':' + v)}`;
          }
        }
      }
      return repointed;
    }
    const absUrl = url.startsWith('//') ? 'https:' + url : url;
    let result = `${helperBase()}/image?u=${encodeURIComponent(absUrl)}`;
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        result += `&h=${encodeURIComponent(k + ':' + v)}`;
      }
    }
    return result;
  },

  // -- History (PER-CLIENT via library.js) ------------------------------
  history(limit) {
    return Promise.resolve(library.history(limit));
  },
  recordHistory(body) {
    // body: {manga, sourceId, chapterUrl, chapterId, chapterTitle,
    //        chapterNumber, page, total} — upsert by manga identity.
    return Promise.resolve(library.recordHistory(body));
  },
  removeHistory(body) {
    // {mangaId}
    return Promise.resolve(library.removeHistory(body));
  },
  clearHistory() {
    return Promise.resolve(library.clearHistory());
  },
  clearLibrary() {
    return Promise.resolve(library.clearAll());
  },

  // -- Favourites (PER-CLIENT via library.js) ---------------------------
  favourites() {
    return Promise.resolve(library.favourites());
  },
  toggleFavourite(manga) {
    // Now TAKES THE FULL MANGA OBJECT so the favourites list renders with no
    // fetch. Returns { favourited }.
    return Promise.resolve(library.toggleFavourite(manga));
  },
  checkFavourite(sid, url) {
    // Callers may pass the mangaId via either arg (or a manga object as `sid`).
    const mangaId = url != null ? url : sid;
    return Promise.resolve({ favourited: library.isFavourite(mangaId) });
  },

  // -- Bookmarks (per-page, PER-CLIENT via library.js) ------------------
  bookmarks() {
    return Promise.resolve(library.bookmarks());
  },
  addBookmark(body) {
    // {manga, sourceId, chapterUrl, chapterId, chapterTitle, page, note}.
    return Promise.resolve(library.addBookmark(body));
  },
  removeBookmark(body) {
    // {id} OR {mangaId, chapterId, page}
    return Promise.resolve(library.removeBookmark(body));
  },
  checkBookmark(body) {
    // {mangaId, chapterId, page} -> { bookmarked, id }
    return Promise.resolve(library.checkBookmark(body));
  },

  // -- Updates (client-computed via library.js) -------------------------
  updates() {
    return Promise.resolve(library.updates());
  },
  refreshUpdates() {
    // Genuinely async: library.refreshUpdates() returns a Promise.
    return Promise.resolve(library.refreshUpdates());
  },
  markUpdatesSeen(body) {
    // {mangaId} — blank/missing marks ALL seen.
    return Promise.resolve(library.markUpdatesSeen(body));
  },

  // -- Local CBZ / folder reader ---------------------------------------
  localScan(folder) {
    return get('/local/scan' + qs({ folder }));
  },
  localChapter(path) {
    return get('/local/chapter' + qs({ cbz: path }));
  },
  // Returns a same-origin URL for a page inside a local cbz.
  localImageUrl(path, entry) {
    return '/local/image' + qs({ cbz: path, entry });
  },

  // -- Global search ----------------------------------------------------
  globalSearch(q, limit = 5) {
    return get('/search/global' + qs({ q, limit }));
  },

  // -- Categories (PER-CLIENT via library.js) ---------------------------
  categories() {
    return Promise.resolve(library.categories());
  },
  // favourites within a category (response shape — {entries}).
  categoryManga(categoryId) {
    return Promise.resolve(library.categoryManga(categoryId));
  },
  createCategory(title) {
    return Promise.resolve(library.createCategory(title));
  },
  renameCategory(id, title) {
    return Promise.resolve(library.renameCategory(id, title));
  },
  deleteCategory(id) {
    return Promise.resolve(library.deleteCategory(id));
  },
  addToCategory(body) {
    // {mangaId, categoryId}
    return Promise.resolve(library.addToCategory(body));
  },
  removeFromCategory(body) {
    // {mangaId, categoryId}
    return Promise.resolve(library.removeFromCategory(body));
  },
  categoriesForManga(sid, url) {
    // Callers may pass the mangaId via either arg (or a manga object as `sid`).
    const mangaId = url != null ? url : sid;
    return Promise.resolve(library.categoriesForManga(mangaId));
  },

  // -- Per-manga reader prefs (PER-CLIENT via library.js) ---------------
  mangaPrefs(sid, url) {
    const mangaId = url != null ? url : sid;
    return Promise.resolve(library.mangaPrefs(mangaId));
  },
  saveMangaPrefs(body) {
    // {mangaId, readerMode, brightness, contrast, saturation, hue, palette}
    return Promise.resolve(library.saveMangaPrefs(body));
  },
  clearMangaPrefs(body) {
    // {mangaId}
    return Promise.resolve(library.clearMangaPrefs(body));
  },

  // -- Downloads (PER-CLIENT via downloads.js) --------------------------
  // The browser has no JVM download service, so downloads run client-side:
  // pages are fetched through the image proxy and packed into CBZ/ZIP archives
  // kept in IndexedDB. These wrappers keep old call-sites working; richer ops
  // (range enqueue, retry, save-to-device, live events) use the manager direct.
  downloads() {
    return Promise.resolve({ entries: downloadManager.list() });
  },
  startDownload(body) {
    // {sourceId, mangaUrl, chapterUrl, mangaTitle, chapterTitle, chapterId,
    //  chapterNumber, mangaId} — single chapter.
    return Promise.resolve(downloadManager.enqueue([{
      sourceId: body && body.sourceId,
      mangaId: body && body.mangaId,
      mangaUrl: body && body.mangaUrl,
      mangaTitle: body && body.mangaTitle,
      chapterUrl: body && body.chapterUrl,
      chapterId: body && body.chapterId,
      chapterTitle: body && body.chapterTitle,
      chapterNumber: body && body.chapterNumber,
    }]));
  },
  cancelDownload(id) {
    return Promise.resolve(downloadManager.cancel(id));
  },
  downloadSettings() {
    const s = downloadManager.getSettings();
    // maxConcurrentDownloads alias kept for any legacy reader of this shape.
    return Promise.resolve({ settings: { ...s, maxConcurrentDownloads: s.maxConcurrent } });
  },
  saveDownloadSettings(body) {
    const patch = {};
    if (body) {
      if (body.maxConcurrent !== undefined) patch.maxConcurrent = body.maxConcurrent;
      else if (body.maxConcurrentDownloads !== undefined) patch.maxConcurrent = body.maxConcurrentDownloads;
      if (body.imageConcurrency !== undefined) patch.imageConcurrency = body.imageConcurrency;
      if (body.retries !== undefined) patch.retries = body.retries;
      if (body.format !== undefined) patch.format = body.format;
      if (body.keepOffline !== undefined) patch.keepOffline = body.keepOffline;
      if (body.saveToDevice !== undefined) patch.saveToDevice = body.saveToDevice;
    }
    const s = downloadManager.saveSettings(patch);
    return Promise.resolve({ settings: { ...s, maxConcurrentDownloads: s.maxConcurrent } });
  },

  // -- Network settings -------------------------------------------------
  networkSettings() {
    return get('/settings/network');
  },
  saveNetworkSettings(body) {
    // {proxyType, proxyAddress, proxyPort, dnsOverHttps, githubMirror,
    //  imagesProxy, sslBypass, disableConnectivityCheck} — all optional.
    return post('/settings/network' + qs(body));
  },

  // -- Stats (client-computed via library.js) ---------------------------
  stats() {
    return Promise.resolve(library.stats());
  },

  // -- Suggestions ------------------------------------------------------
  suggestions() {
    return get('/suggestions');
  },

  // -- Alternative sources for a title ---------------------------------
  // Server param is `title`. Signature kept flexible: alternatives(sid, url, title)
  // or alternatives(title). The last non-null string is treated as the title.
  alternatives(sid, url, title) {
    const t = title != null ? title : (url != null ? url : sid);
    return get('/manga/alternatives' + qs({ title: t }));
  },

  // -- Backup (PER-CLIENT via library.js) -------------------------------
  // Export the whole library object (the export shape).
  exportBackup() {
    return Promise.resolve(library.exportData());
  },
  // Import accepts the export object, or a raw JSON string of it.
  importBackup(json) {
    const obj = typeof json === 'string'
      ? (() => { try { return JSON.parse(json); } catch { return null; } })()
      : json;
    return Promise.resolve(library.importData(obj));
  },

  // (Account sync is handled entirely by core/sync.js against the hosted
  //  stream backend at NYORA_SYNC_URL.)
};

export default api;
