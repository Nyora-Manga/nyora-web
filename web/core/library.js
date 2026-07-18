// core/library.js — per-client library, stored entirely in the browser.
//
// WHY THIS EXISTS
// ----------------
// The deployed Nyora web app uses ONE shared server-side SQLite database, so
// every visitor sees everyone else's favourites/history/bookmarks. That is
// wrong for a public deployment. The fix is to keep all *personal* state in the
// visitor's own browser via localStorage — which is per-origin per-browser, so
// each client is automatically isolated with zero server involvement.
//
// The server keeps ONLY the shared, read-only catalog: browse/details/pages/
// image/search/sources/suggestions/downloads/network/anilist all stay
// server-backed and unchanged. This module replaces the personal endpoints
// (/library/*, /manga/prefs*, /stats) that api.js used to call.
//
// DESIGN
// ------
//  * ONE localStorage key, 'nyora.library.v1', holds a single JSON object.
//  * Load/save are wrapped in try/catch; if localStorage is unavailable
//    (private mode, disabled, quota) we transparently fall back to an in-memory
//    object so the app keeps working for the session.
//  * Manga identity key = manga.id || (sourceId + '|' + manga.url). FULL manga
//    objects are stored so list screens can render covers/titles with no extra
//    network round-trip.
//  * Every public method returns a PLAIN value (not a Promise) EXCEPT
//    refreshUpdates(), which is genuinely async. api.js wraps the plain values
//    in Promise.resolve(...) so existing `await api.foo()` call-sites keep
//    working.
//
// Response shapes deliberately mirror the OLD server shapes ({entries:[...]},
// {favourited}, {bookmarked,id}, {categories:[...]}, ...) so the screens change
// as little as possible.

import db from './db.js';

const STORAGE_KEY = 'nyora.library.v1';

// ---- persistence -------------------------------------------------------

// The canonical, empty library shape. Every top-level collection is created
// here so the rest of the code can assume the buckets always exist.
function emptyData() {
  return {
    favourites: {},     // mangaId -> { manga, addedAt }
    history: {},        // mangaId -> HistoryEntry
    bookmarks: [],      // Bookmark[]
    categories: {},     // categoryId -> { id, title, createdAt }
    categoryMembers: {},// categoryId -> { mangaId: true }
    prefs: {},          // mangaId -> { ...prefs }
    snapshots: {},      // mangaId -> { chapterCount, chapterUrls, seen, newChapters, latestChapterTitle, sourceId, lastSyncedAt }
    seq: 1,             // monotonic counter for bookmark/category ids
  };
}

// Probe localStorage once. If it throws (Safari private mode historically
// threw on setItem), we mark it unavailable and use the in-memory fallback.
let _storageOk = true;
(function probeStorage() {
  try {
    const k = '__nyora_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    _storageOk = true;
  } catch {
    _storageOk = false;
  }
})();

// In-memory mirror; always the source of truth for the running session. We load
// it from localStorage once, then keep it in sync on every save.
let _data = loadData();

// One-time mirror on boot so an existing localStorage library hydrates the
// IndexedDB schema store (sync source-of-truth) even before the first mutation.
try { db.mirrorAll(_data); } catch { /* ignore */ }

function loadData() {
  const base = emptyData();
  if (!_storageOk) return base;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return base;
    // Merge defensively so a partial/old object never crashes a getter.
    return mergeShape(base, parsed);
  } catch {
    // Corrupt JSON / read error — start clean rather than throwing.
    return base;
  }
}

// Shallow-merge known buckets from a stored object onto a fresh empty shape,
// keeping only the right container types so a getter never sees a surprise.
function mergeShape(base, stored) {
  const out = base;
  if (isObject(stored.favourites)) out.favourites = stored.favourites;
  if (isObject(stored.history)) out.history = stored.history;
  if (Array.isArray(stored.bookmarks)) out.bookmarks = stored.bookmarks;
  if (isObject(stored.categories)) out.categories = stored.categories;
  if (isObject(stored.categoryMembers)) out.categoryMembers = stored.categoryMembers;
  if (isObject(stored.prefs)) out.prefs = stored.prefs;
  if (isObject(stored.snapshots)) out.snapshots = stored.snapshots;
  if (Number.isFinite(stored.seq)) out.seq = stored.seq;
  return out;
}

function save() {
  // Mirror into the IndexedDB schema store (mac/Supabase shape) for future
  // cross-platform sync — best-effort, debounced, never blocks the UI.
  try { db.mirrorAll(_data); } catch { /* ignore */ }
  if (!_storageOk) return; // in-memory only — nothing else to persist
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_data));
  } catch {
    // Quota exceeded / disabled mid-session: keep running from memory.
    _storageOk = false;
  }
}

// ---- small helpers -----------------------------------------------------

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function now() {
  return Date.now();
}

function nextId(prefix) {
  const n = _data.seq || 1;
  _data.seq = n + 1;
  return `${prefix}_${n}_${now().toString(36)}`;
}

// Identity key for a manga. Prefer the engine id; else compose from source +
// url so two manga from the same source never collide and the same manga from
// different sources stays distinct.
function keyOf(manga, sourceId) {
  if (!manga) return '';
  if (manga.id !== undefined && manga.id !== null && manga.id !== '') {
    return String(manga.id);
  }
  const sid = sourceId != null ? sourceId : sourceFromManga(manga);
  const url = manga.url != null ? manga.url : '';
  return `${sid || ''}|${url}`;
}

// Best-effort source id from a manga's polymorphic `source` ref (matches the
// resolution screens do): a string, or {name|id}.
function sourceFromManga(manga) {
  const s = manga && manga.source;
  if (!s) return '';
  let name = '';
  if (typeof s === 'string') name = s;
  else name = s.name || s.id || s.type || '';
  if (name.includes('.MangaSourceRef.')) name = name.split('.MangaSourceRef.').pop();
  return name;
}

// Make a defensive copy so callers can't mutate our internal state by reference.
function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

// Resolve a "manga id" argument: callers sometimes pass the id string, and
// sometimes a whole manga object. Normalise to the string key.
function asMangaId(mangaOrId, sourceId) {
  if (mangaOrId == null) return '';
  if (typeof mangaOrId === 'object') return keyOf(mangaOrId, sourceId);
  return String(mangaOrId);
}

function clampPercent(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// ---- the library object ------------------------------------------------

export const library = {
  // ====================================================================
  // Favourites
  // ====================================================================

  // newest-added first
  favourites() {
    const entries = Object.values(_data.favourites)
      .slice()
      .sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0))
      .map((rec) => clone(rec.manga))
      .filter(Boolean);
    return { entries };
  },

  isFavourite(mangaId) {
    const id = asMangaId(mangaId);
    return !!(id && _data.favourites[id]);
  },

  // TAKES THE FULL MANGA OBJECT so the favourites list can render without a
  // fetch. Toggling off removes it (and any category memberships).
  toggleFavourite(manga) {
    const id = keyOf(manga);
    if (!id) return { favourited: false };
    if (_data.favourites[id]) {
      this.removeFavourite(id);
      return { favourited: false };
    }
    _data.favourites[id] = { manga: clone(manga), addedAt: now() };
    save();
    return { favourited: true };
  },

  removeFavourite(mangaId) {
    const id = asMangaId(mangaId);
    if (!id) return;
    delete _data.favourites[id];
    // Drop it from every category it belonged to.
    for (const catId of Object.keys(_data.categoryMembers)) {
      if (_data.categoryMembers[catId] && _data.categoryMembers[catId][id]) {
        delete _data.categoryMembers[catId][id];
      }
    }
    save();
  },

  // Backfill/replace a favourite's cover (the source's `details` often omits the
  // cover, so the library screen resolves it from search and persists it here).
  setFavouriteCover(mangaOrId, coverUrl, title) {
    const id = asMangaId(mangaOrId);
    const rec = id && _data.favourites[id];
    if (!rec || !rec.manga) return false;
    let changed = false;
    if (coverUrl && !(rec.manga.coverUrl || rec.manga.largeCoverUrl)) {
      rec.manga.coverUrl = coverUrl;
      rec.manga.largeCoverUrl = rec.manga.largeCoverUrl || coverUrl;
      changed = true;
    }
    if (title && (!rec.manga.title || rec.manga.title === 'Untitled')) {
      rec.manga.title = title;
      changed = true;
    }
    if (changed) save();
    return changed;
  },

  // ====================================================================
  // History
  // ====================================================================

  // newest updatedAt first
  history(limit) {
    let entries = Object.values(_data.history)
      .slice()
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      .map(clone);
    const n = Number(limit);
    if (Number.isFinite(n) && n > 0) entries = entries.slice(0, n);
    return { entries };
  },

  // Upsert by manga identity. Keeps the FULL manga object on the entry so the
  // history screen renders covers/titles with no fetch.
  recordHistory(body) {
    if (!body) return;
    const manga = body.manga;
    // Respect "Keep 18+ out of history" — never persist adult manga when enabled.
    try {
      const prefs = JSON.parse(localStorage.getItem('nyora.prefs') || '{}');
      // Incognito: don't record ANY reading history while enabled.
      if (prefs.incognito) return;
      const mangaNsfw = manga &&
        (manga.isNsfw === true || /adult|porn|erotic|hentai|nsfw/i.test(String(manga.contentRating || '')));
      // body.sourceNsfw = the source itself is adult (airtight: catches titles
      // from 18+ sources even without a per-title rating).
      if (prefs.noNsfwHistory && (body.sourceNsfw === true || mangaNsfw)) {
        return;
      }
    } catch { /* ignore */ }
    const sourceId = body.sourceId != null ? body.sourceId : sourceFromManga(manga);
    const id = manga ? keyOf(manga, sourceId) : asMangaId(body.mangaId, sourceId);
    if (!id) return;

    const total = Number(body.total) || 0;
    const page = Number(body.page) || 0;
    const percent = body.percent != null
      ? clampPercent(body.percent)
      : (total > 0 ? clampPercent((page + 1) / total) : 0);

    const prev = _data.history[id] || {};
    // Never let a cover-less details object clobber a cover we already stored.
    const nextManga = manga ? clone(manga) : (prev.manga || null);
    // A details response that comes back thin (some sources/helper versions omit
    // fields) must never blank out metadata we already have — that's how an
    // entry ended up rendering as "Untitled" with no artwork after a re-read.
    // The cover was already protected; title/url/author need the same guard.
    if (nextManga && prev.manga) {
      for (const k of ['title', 'coverUrl', 'largeCoverUrl', 'url', 'author']) {
        if (!nextManga[k] && prev.manga[k]) nextManga[k] = prev.manga[k];
      }
    }
    _data.history[id] = {
      manga: nextManga,
      sourceId,
      chapterUrl: body.chapterUrl != null ? body.chapterUrl : (prev.chapterUrl || ''),
      chapterId: body.chapterId != null ? body.chapterId
        : (body.chapterUrl != null ? body.chapterUrl : (prev.chapterId || '')),
      chapterTitle: body.chapterTitle != null ? body.chapterTitle : (prev.chapterTitle || ''),
      chapterNumber: body.chapterNumber != null ? body.chapterNumber : (prev.chapterNumber ?? null),
      page,
      total,
      percent,
      updatedAt: now(),
    };
    save();
  },

  // Repair metadata on an existing history entry WITHOUT touching updatedAt,
  // page or percent — a migration must not reshuffle the user's history order
  // or claim they re-read something. Only fills fields that are currently
  // empty, so it can never overwrite something the user has.
  patchHistoryManga(mangaId, fields) {
    const id = String(mangaId || '');
    const entry = _data.history[id];
    if (!id || !entry || !fields) return false;
    const manga = entry.manga ? clone(entry.manga) : {};
    let changed = false;
    for (const k of ['title', 'coverUrl', 'largeCoverUrl', 'author', 'url']) {
      if (!manga[k] && fields[k]) { manga[k] = fields[k]; changed = true; }
    }
    if (!changed) return false;
    entry.manga = manga;
    save();
    return true;
  },

  // History entries whose display metadata is incomplete (see migrations.js).
  brokenHistoryEntries() {
    return Object.entries(_data.history)
      .filter(([, e]) => e && e.manga
        && (!e.manga.title || (!e.manga.coverUrl && !e.manga.largeCoverUrl)))
      .map(([id, e]) => ({ id, sourceId: e.sourceId, manga: clone(e.manga) }));
  },

  removeHistory(body) {
    const id = asMangaId(body && (body.mangaId != null ? body.mangaId : body.manga));
    if (!id) return;
    delete _data.history[id];
    save();
  },

  clearHistory() {
    _data.history = {};
    save();
  },

  // ====================================================================
  // Bookmarks (per reader page)
  // ====================================================================

  bookmarks() {
    const entries = _data.bookmarks
      .slice()
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
      .map(clone);
    return { entries };
  },

  // INSERT-OR-REPLACE on (mangaId, chapterId, page) so re-adding with the same
  // coordinates updates the note in place (matches the desktop behaviour).
  addBookmark(body) {
    if (!body) return { id: null };
    const manga = body.manga;
    const sourceId = body.sourceId != null ? body.sourceId : sourceFromManga(manga);
    const mangaId = manga ? keyOf(manga, sourceId) : asMangaId(body.mangaId, sourceId);
    if (!mangaId) return { id: null };

    const chapterId = body.chapterId != null ? body.chapterId
      : (body.chapterUrl != null ? body.chapterUrl : '');
    const page = Number(body.page) || 0;
    const note = body.note != null ? String(body.note) : '';

    const existing = _data.bookmarks.find(
      (b) => b.mangaId === mangaId && b.chapterId === chapterId && Number(b.page) === page,
    );
    if (existing) {
      existing.note = note;
      if (manga) existing.manga = clone(manga);
      if (body.chapterTitle != null) existing.chapterTitle = body.chapterTitle;
      if (body.chapterUrl != null) existing.chapterUrl = body.chapterUrl;
      save();
      return { id: existing.id };
    }

    const id = nextId('bm');
    _data.bookmarks.push({
      id,
      mangaId,
      manga: manga ? clone(manga) : null,
      sourceId,
      chapterUrl: body.chapterUrl != null ? body.chapterUrl : chapterId,
      chapterId,
      chapterTitle: body.chapterTitle != null ? body.chapterTitle : '',
      page,
      note,
      createdAt: now(),
    });
    save();
    return { id };
  },

  // Remove by {id} OR by ({mangaId, chapterId, page}) coordinates.
  removeBookmark(body) {
    if (!body) return;
    const before = _data.bookmarks.length;
    if (body.id != null) {
      _data.bookmarks = _data.bookmarks.filter((b) => b.id !== body.id);
    } else {
      const mangaId = asMangaId(body.mangaId);
      const chapterId = body.chapterId != null ? body.chapterId : '';
      const page = Number(body.page) || 0;
      _data.bookmarks = _data.bookmarks.filter(
        (b) => !(b.mangaId === mangaId && b.chapterId === chapterId && Number(b.page) === page),
      );
    }
    if (_data.bookmarks.length !== before) save();
  },

  checkBookmark(body) {
    if (!body) return { bookmarked: false, id: null };
    const mangaId = asMangaId(body.mangaId);
    const chapterId = body.chapterId != null ? body.chapterId : '';
    const page = Number(body.page) || 0;
    const hit = _data.bookmarks.find(
      (b) => b.mangaId === mangaId && b.chapterId === chapterId && Number(b.page) === page,
    );
    return hit ? { bookmarked: true, id: hit.id } : { bookmarked: false, id: null };
  },

  // ====================================================================
  // Categories (collections of favourites)
  // ====================================================================

  categories() {
    const categories = Object.values(_data.categories)
      .filter((c) => !c.deletedAt) // skip soft-deleted (kept around so the deletion can sync)
      .slice()
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
      .map((c) => ({
        id: c.id,
        title: c.title,
        mangaCount: this._countCategory(c.id),
      }));
    return { categories };
  },

  _countCategory(categoryId) {
    const members = _data.categoryMembers[categoryId];
    if (!members) return 0;
    // Only count members that are still favourited.
    let n = 0;
    for (const mangaId of Object.keys(members)) {
      if (members[mangaId] && _data.favourites[mangaId]) n++;
    }
    return n;
  },

  categoryManga(categoryId) {
    const members = _data.categoryMembers[categoryId] || {};
    const entries = Object.keys(members)
      .filter((mangaId) => members[mangaId] && _data.favourites[mangaId])
      .map((mangaId) => ({ mangaId, rec: _data.favourites[mangaId] }))
      .sort((a, b) => (Number(b.rec.addedAt) || 0) - (Number(a.rec.addedAt) || 0))
      .map((x) => clone(x.rec.manga))
      .filter(Boolean);
    return { entries };
  },

  createCategory(title) {
    const id = nextId('cat');
    _data.categories[id] = {
      id,
      title: title != null ? String(title) : 'Untitled',
      createdAt: now(),
    };
    _data.categoryMembers[id] = {};
    save();
    return { id };
  },

  renameCategory(id, title) {
    const cat = _data.categories[id];
    if (!cat) return;
    cat.title = title != null ? String(title) : cat.title;
    save();
  },

  // Soft-delete: stamp deletedAt and KEEP the record (and its categoryMembers)
  // so the deletion propagates on the next sync push. The categories() getter
  // and the display/assignment helpers skip records that carry a deletedAt.
  deleteCategory(id) {
    const cat = _data.categories[id];
    if (!cat) return;
    cat.deletedAt = now();
    save();
  },

  // Collapse duplicate same-title categories that accumulate across synced
  // devices (legacy per-device "Read later" seeds, etc.). Among the non-deleted
  // categories, group by title; the canonical one is the member with the
  // smallest id (string comparison). Each duplicate's members are merged into
  // the canonical's map, then the duplicate is soft-deleted so the merge syncs.
  // Mirrors the Android repointDuplicateFavourites + softDeleteDuplicateCategories.
  dedupeCategories() {
    const byTitle = new Map(); // title -> canonical id (smallest)
    for (const cat of Object.values(_data.categories)) {
      if (!cat || cat.deletedAt) continue;
      const title = cat.title || '';
      const prev = byTitle.get(title);
      if (prev == null || String(cat.id) < String(prev)) byTitle.set(title, cat.id);
    }

    let changed = false;
    for (const cat of Object.values(_data.categories)) {
      if (!cat || cat.deletedAt) continue;
      const canonicalId = byTitle.get(cat.title || '');
      if (canonicalId == null || String(cat.id) === String(canonicalId)) continue;

      // Merge this duplicate's members into the canonical category.
      const dupMembers = _data.categoryMembers[cat.id];
      if (dupMembers) {
        if (!_data.categoryMembers[canonicalId]) _data.categoryMembers[canonicalId] = {};
        for (const mangaId of Object.keys(dupMembers)) {
          if (dupMembers[mangaId]) _data.categoryMembers[canonicalId][mangaId] = true;
        }
      }
      cat.deletedAt = now();
      changed = true;
    }

    if (changed) save();
  },

  addToCategory(body) {
    if (!body) return;
    const mangaId = asMangaId(body.mangaId);
    const categoryId = body.categoryId;
    const cat = _data.categories[categoryId];
    if (!mangaId || categoryId == null || !cat || cat.deletedAt) return;
    if (!_data.categoryMembers[categoryId]) _data.categoryMembers[categoryId] = {};
    _data.categoryMembers[categoryId][mangaId] = true;
    save();
  },

  removeFromCategory(body) {
    if (!body) return;
    const mangaId = asMangaId(body.mangaId);
    const categoryId = body.categoryId;
    if (!mangaId || categoryId == null) return;
    if (_data.categoryMembers[categoryId]) {
      delete _data.categoryMembers[categoryId][mangaId];
      save();
    }
  },

  categoriesForManga(mangaId) {
    const id = asMangaId(mangaId);
    const categories = [];
    for (const catId of Object.keys(_data.categoryMembers)) {
      const cat = _data.categories[catId];
      if (cat && !cat.deletedAt && _data.categoryMembers[catId] && _data.categoryMembers[catId][id]) {
        categories.push({ id: cat.id, title: cat.title });
      }
    }
    return { categories };
  },

  // ====================================================================
  // Per-manga reader prefs
  // ====================================================================

  mangaPrefs(mangaId) {
    const id = asMangaId(mangaId);
    const p = id && _data.prefs[id];
    return p ? clone(p) : {};
  },

  saveMangaPrefs(body) {
    if (!body) return;
    const id = asMangaId(body.mangaId != null ? body.mangaId : body.manga);
    if (!id) return;
    const { mangaId, manga, ...prefs } = body; // strip the key fields
    void mangaId;
    void manga;
    _data.prefs[id] = { ...(_data.prefs[id] || {}), ...clone(prefs) };
    save();
  },

  clearMangaPrefs(body) {
    const id = asMangaId(body && (body.mangaId != null ? body.mangaId : body.manga));
    if (!id) return;
    delete _data.prefs[id];
    save();
  },

  // ====================================================================
  // Updates (client-computed from stored snapshots)
  // ====================================================================

  // Build update rows from the persisted snapshots: any favourite whose stored
  // snapshot has unseen new chapters shows up here.
  updates() {
    const entries = [];
    for (const mangaId of Object.keys(_data.snapshots)) {
      const snap = _data.snapshots[mangaId];
      if (!snap || snap.seen) continue;
      const newChapters = Number(snap.newChapters) || 0;
      if (newChapters <= 0) continue;
      const fav = _data.favourites[mangaId];
      const manga = (fav && fav.manga) || snap.manga || null;
      entries.push(clone({
        mangaId,
        manga,
        mangaTitle: (manga && manga.title) || snap.mangaTitle || '',
        mangaCoverUrl: (manga && (manga.coverUrl || manga.largeCoverUrl)) || snap.mangaCoverUrl || '',
        sourceId: snap.sourceId || sourceFromManga(manga),
        newChapters,
        totalChapters: Number(snap.chapterCount) || 0,
        latestChapterTitle: snap.latestChapterTitle || '',
        lastSyncedAt: Number(snap.lastSyncedAt) || 0,
        newChapterList: Array.isArray(snap.newChapterList) ? snap.newChapterList : [],
      }));
    }
    // Most new chapters first, then most recently synced.
    entries.sort((a, b) =>
      (b.newChapters - a.newChapters) ||
      ((Number(b.lastSyncedAt) || 0) - (Number(a.lastSyncedAt) || 0)));
    return { entries };
  },

  // For each favourite, fetch fresh details and diff the chapter count against
  // the stored snapshot. New chapters are listed and a fresh snapshot persisted.
  // `fetcher` lets a test inject a details fn; otherwise api.js is imported
  // lazily to avoid a static import cycle (api.js imports this module).
  async refreshUpdates(fetcher) {
    let details = fetcher;
    if (typeof details !== 'function') {
      try {
        const mod = await import('./api.js');
        const api = mod.api || mod.default;
        details = (sourceId, url) => api.details(sourceId, url);
      } catch {
        details = null;
      }
    }

    let checked = 0;
    let withNew = 0;

    const favs = Object.values(_data.favourites);
    for (const rec of favs) {
      const manga = rec && rec.manga;
      if (!manga || !manga.url) continue;
      const sourceId = sourceFromManga(manga);
      const mangaId = keyOf(manga, sourceId);
      if (!sourceId || !details) continue;

      let res;
      try {
        res = await details(sourceId, manga.url);
      } catch {
        continue; // skip titles whose source can't be reached this pass
      }
      checked++;

      const chapters = extractChapters(res);
      const chapterUrls = chapters.map((c) => c && (c.url || c.id)).filter(Boolean);
      const count = chapters.length;

      const prev = _data.snapshots[mangaId];
      const prevCount = prev ? (Number(prev.chapterCount) || 0) : null;

      let newList = [];
      if (prev && prevCount != null && count > prevCount) {
        const known = new Set(Array.isArray(prev.chapterUrls) ? prev.chapterUrls : []);
        newList = chapters
          .filter((c) => {
            const u = c && (c.url || c.id);
            return u && !known.has(u);
          })
          .map((c, i) => ({
            url: c.url || c.id || '',
            title: chapterTitleOf(c, i),
          }));
        // Fallback: if url-diffing found nothing (e.g. urls churn), use the
        // count delta tail.
        if (!newList.length) {
          newList = chapters.slice(prevCount).map((c, i) => ({
            url: c.url || c.id || '',
            title: chapterTitleOf(c, prevCount + i),
          }));
        }
      }

      const grew = newList.length > 0;
      if (grew) withNew++;

      const carriedNew = prev && !prev.seen
        ? (Array.isArray(prev.newChapterList) ? prev.newChapterList : [])
        : [];
      const combinedNew = grew ? carriedNew.concat(newList) : carriedNew;

      _data.snapshots[mangaId] = {
        sourceId,
        manga: clone(manga),
        mangaTitle: manga.title || '',
        mangaCoverUrl: manga.coverUrl || manga.largeCoverUrl || '',
        chapterCount: count,
        chapterUrls,
        latestChapterTitle: chapters.length ? chapterTitleOf(chapters[chapters.length - 1], chapters.length - 1) : '',
        newChapters: combinedNew.length,
        newChapterList: combinedNew,
        seen: prev ? (grew ? false : !!prev.seen) : true, // first-ever snapshot is the baseline = seen
        lastSyncedAt: now(),
      };
    }

    save();
    return { ...this.updates(), checked, withNew };
  },

  // Missing/blank mangaId marks ALL snapshots seen.
  markUpdatesSeen(body) {
    const id = asMangaId(body && body.mangaId);
    if (!id) {
      for (const k of Object.keys(_data.snapshots)) {
        _data.snapshots[k].seen = true;
        _data.snapshots[k].newChapters = 0;
        _data.snapshots[k].newChapterList = [];
      }
    } else if (_data.snapshots[id]) {
      _data.snapshots[id].seen = true;
      _data.snapshots[id].newChapters = 0;
      _data.snapshots[id].newChapterList = [];
    }
    save();
  },

  // ====================================================================
  // Stats (client-computed from history + favourites)
  // ====================================================================

  stats() {
    const historyEntries = Object.values(_data.history);
    const favEntries = Object.values(_data.favourites);

    const totalManga = historyEntries.length;
    const totalFavourites = favEntries.length;

    // totalChapters: count distinct (manga, chapter) reads we know about — we
    // only persist the latest chapter per manga, so this is at least the number
    // of manga with reading progress.
    const totalChapters = historyEntries.filter((h) => h && (h.chapterId || h.chapterUrl)).length;

    // bySource leaderboard: read-count per source, derived from history.
    const counts = new Map(); // sourceKey -> { sourceName, count }
    for (const h of historyEntries) {
      const sid = h && h.sourceId;
      const name = sourceNameOf(h && h.manga, sid);
      const key = String(sid || name || 'unknown');
      const cur = counts.get(key) || { sourceName: name || key, count: 0 };
      cur.count += 1;
      counts.set(key, cur);
    }
    const bySource = Array.from(counts.values())
      .sort((a, b) => b.count - a.count);

    return {
      totalChapters,
      totalManga,
      totalFavourites,
      bySource,
      // Aliases mirroring the old server keys so existing screens keep working.
      distinctManga: totalManga,
      favouritesCount: totalFavourites,
      longestStreakDays: 0,
      topSources: bySource.slice(0, 5).map((s) => ({
        sourceId: s.sourceName,
        sourceName: s.sourceName,
        count: s.count,
      })),
    };
  },

  // ====================================================================
  // Backup
  // ====================================================================

  exportData() {
    return clone(_data);
  },

  importData(obj) {
    if (!obj || typeof obj !== 'object') return;
    _data = mergeShape(emptyData(), obj);
    save();
  },

  clearAll() {
    _data = emptyData();
    save();
  },
};

// Collapse duplicate same-title categories on boot (legacy per-device seeds
// accumulate across synced devices). Runs once against the freshly-loaded data.
try { library.dedupeCategories(); } catch { /* ignore */ }

// ---- chapter/source extraction helpers ---------------------------------

// /manga/details may return chapters under several shapes; normalise to an
// array. Accepts {chapters:[...]}, {manga:{chapters}}, or a bare array.
function extractChapters(res) {
  if (!res) return [];
  if (Array.isArray(res.chapters)) return res.chapters;
  if (res.manga && Array.isArray(res.manga.chapters)) return res.manga.chapters;
  if (Array.isArray(res)) return res;
  return [];
}

function chapterTitleOf(c, index) {
  if (!c) return `Chapter ${index + 1}`;
  if (c.title && String(c.title).trim()) return String(c.title).trim();
  if (c.name && String(c.name).trim()) return String(c.name).trim();
  if (c.number != null) return `Chapter ${c.number}`;
  return `Chapter ${index + 1}`;
}

function sourceNameOf(manga, sourceId) {
  const fromManga = sourceFromManga(manga);
  if (fromManga) return fromManga;
  return sourceId != null ? String(sourceId) : '';
}

export default library;
