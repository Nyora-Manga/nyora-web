// core/api.js — REST client for the Nyora web SPA.
//
// The shared, read-only catalog (catalog/popular/latest/search/details/pages
// + the /image proxy) is served by the hosted parser helper at
// NYORA_HELPER_URL (https://api.hasanraza.tech). Those calls hit the helper
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
  const u = globalThis.NYORA_HELPER_URL || 'https://api.hasanraza.tech';
  return String(u).replace(/\/+$/, '');
}

// Map the SPA's internal route names onto the helper's route names. The helper
// serves manga detail/page reads under /sources/details and /sources/pages.
function helperPath(path) {
  const idx = String(path).indexOf('?');
  const route = idx === -1 ? String(path) : String(path).slice(0, idx);
  const query = idx === -1 ? '' : String(path).slice(idx);
  let r = route;
  if (r === '/manga/details') r = '/sources/details';
  else if (r === '/manga/pages') r = '/sources/pages';
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
  const res = await fetch(helperBase() + helperPath(path), { headers: { Accept: 'application/json' } });
  const data = await parseBody(res);
  return ensureOk(res, data);
}

async function helperPost(path, body) {
  const init = { method: 'POST', headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(helperBase() + helperPath(path), init);
  const data = await parseBody(res);
  return ensureOk(res, data);
}

export async function get(path) {
  // Prefer the hosted helper for the shared catalog; fall back to the
  // in-browser web parsers, then to the same-origin backend.
  if (helperGetRoute(path)) {
    try {
      return await helperGet(path);
    } catch (e) {
      const fallback = await parserGet(path);
      if (fallback) return fallback;
      throw e;
    }
  }
  const parserResult = await parserGet(path);
  if (parserResult) return parserResult;
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


// ---- AniList tracker (direct client-side GraphQL) ----------------------
// AniList's API is CORS-enabled (ACAO:* and allows the Authorization header),
// so the browser talks to it directly — no server, no CORS worker. The token
// (held by the tracker screen) is sent only to AniList over HTTPS.
const ANILIST_API = 'https://graphql.anilist.co';

const ANILIST_SEARCH = `query ($search: String) {
  Page(perPage: 12) {
    media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
      id
      title { romaji english native }
      coverImage { large }
      averageScore
      chapters
      format
      isAdult
      mediaListEntry { status progress }
    }
  }
}`;

const ANILIST_SAVE = `mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
    id status progress
  }
}`;

async function anilistGraphQL(query, variables, token) {
  const res = await fetch(ANILIST_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  // Return the raw GraphQL envelope ({data, errors}); the tracker screen reads
  // raw.data.Page.media / raw.data.SaveMediaListEntry and handles raw.errors.
  const data = await parseBody(res);
  if (!res.ok && !(data && data.errors)) {
    throw new Error((data && data.message) || `AniList error ${res.status}`);
  }
  return data;
}

// ---- the api surface ---------------------------------------------------

export const api = {
  // expose the low-level helpers too
  get,
  post,
  del,

  // -- Sources ----------------------------------------------------------
  listSources() {
    return get('/sources');
  },
  refreshSources() {
    return post('/sources/refresh');
  },
  catalog() {
    return get('/sources/catalog');
  },
  installSource(id) {
    return post('/sources/install' + qs({ id }));
  },
  uninstallSource(id) {
    return post('/sources/uninstall' + qs({ id }));
  },
  pinSource(id, pinned) {
    // Server toggles by id; `pinned` is sent for forward-compat/intent.
    return post('/sources/pin' + qs({ id, pinned }));
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

  // -- Tracker: AniList (direct client-side GraphQL — no server/worker) --
  anilistSearch(q, token) {
    // Returns the raw {data:{Page:{media:[...]}}} envelope.
    return anilistGraphQL(ANILIST_SEARCH, { search: q }, token);
  },
  anilistScrobble(body, token) {
    // {mediaId, progress, status} -> {data:{SaveMediaListEntry:{…}}}
    return anilistGraphQL(ANILIST_SAVE, {
      mediaId: Number(body && body.mediaId),
      progress: Number(body && body.progress) || 0,
      status: body && body.status,
    }, token);
  },
  // (Account sync is handled entirely by core/sync.js against the hosted
  //  stream backend at NYORA_SYNC_URL.)
};

export default api;
