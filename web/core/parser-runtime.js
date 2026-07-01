
// SortOrder is a tiny enum from base.js (no parser graph) — keep it static.
// The bundled fallback parsers (~244 KB) load lazily via bundledParsers(), only
// when the OTA runtime fails, so they stay out of the initial page bundle.
import { SortOrder } from './web-parsers/base.js';

let _bundledPromise = null;
function bundledParsers() {
  if (!_bundledPromise) _bundledPromise = import('./web-parsers/index.js');
  return _bundledPromise;
}

const PROXY_KEY = 'nyora.webParser.proxyUrl';
const SOURCE_PREFS_KEY = 'nyora.webParser.sources';
const OTA_BASE_KEY = 'nyora.webParser.otaBase';
const OTA_MANIFEST_URL_KEY = 'nyora.webParser.otaManifestUrl';
// v5: catalog is the canonical 121-source JS-only OTA set.
const SOURCE_PREFS_VERSION = 5;
const DEFAULT_PROXY_URL = 'https://nyora-cors-proxy.nyora.workers.dev';
const DEFAULT_OTA_BASE = 'https://hasan72341.github.io/nyora-ota-parsers';
// Default catalog — only sources verified to return live results through the
// CORS worker (the datacenter IP must be served). All 5 pins probe green with
// covers; broken/blocked sources (MangaFire IP-blocks datacenters, TopManhua/
// Toonily 400, KissManga 522, etc.) are intentionally left out of the defaults.
const DEFAULT_PINNED = ['ASURASCANS_US', 'MANGANATO_GG', 'NYXSCANS', 'DANKE', 'VORTEXSCANS'];
const DEFAULT_INSTALLED = ['ASURASCANS_US', 'MANGANATO_GG', 'NYXSCANS', 'DANKE', 'VORTEXSCANS', 'TOONGOD'];

let sourcesPromise = null;
let runtimePromise = null;

function proxyBase() {
  try {
    return (localStorage.getItem(PROXY_KEY) || DEFAULT_PROXY_URL).replace(/\/+$/, '');
  } catch {
    return DEFAULT_PROXY_URL;
  }
}

function otaManifestUrl() {
  try {
    const explicit = localStorage.getItem(OTA_MANIFEST_URL_KEY);
    if (explicit) return explicit;
    const base = (localStorage.getItem(OTA_BASE_KEY) || DEFAULT_OTA_BASE).replace(/\/+$/, '');
    return `${base}/manifest.json`;
  } catch {
    return `${DEFAULT_OTA_BASE}/manifest.json`;
  }
}

async function sha256Hex(data) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) return '';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function loadScriptText(source) {
  const script = document.createElement('script');
  script.textContent = `${source}\n;globalThis.NyoraParsers = NyoraParsers;`;
  document.head.appendChild(script);
  script.remove();
  return globalThis.NyoraParsers || null;
}

async function fetchJsonVerified(url, expectedSha) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
  const bytes = await res.arrayBuffer();
  if (expectedSha) {
    const actual = await sha256Hex(bytes);
    if (actual && actual !== expectedSha) {
      throw new Error(`SHA-256 mismatch for ${url}`);
    }
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function loadOtaRuntime() {
  const manifestUrl = otaManifestUrl();
  const sep = manifestUrl.includes('?') ? '&' : '?';
  const manifest = await fetchJsonVerified(`${manifestUrl}${sep}t=${Date.now()}`);
  const bundleUrl = manifest && manifest.bundle && manifest.bundle.url;
  if (!bundleUrl) throw new Error('OTA manifest missing bundle.url');

  const bundleRes = await fetch(bundleUrl, { cache: 'no-store' });
  if (!bundleRes.ok) throw new Error(`HTTP ${bundleRes.status} loading ${bundleUrl}`);
  const bundleBytes = await bundleRes.arrayBuffer();
  const expectedBundleSha = manifest.bundle && manifest.bundle.sha256;
  if (expectedBundleSha) {
    const actual = await sha256Hex(bundleBytes);
    if (actual && actual !== expectedBundleSha) {
      throw new Error('SHA-256 mismatch for OTA parser bundle');
    }
  }
  const bundleText = new TextDecoder().decode(bundleBytes);
  const runtime = loadScriptText(bundleText);
  if (!runtime || typeof runtime.getParser !== 'function' || typeof runtime.getAllSources !== 'function') {
    throw new Error('OTA parser bundle did not expose NyoraParsers');
  }

  let sources = runtime.getAllSources();
  if (manifest.sources && manifest.sources.url) {
    sources = await fetchJsonVerified(manifest.sources.url, manifest.sources.sha256);
  }
  return {
    version: manifest.version || 0,
    source: 'ota',
    sources,
    getParser: runtime.getParser,
  };
}

async function parserRuntime() {
  if (!runtimePromise) {
    runtimePromise = loadOtaRuntime().catch((error) => {
      return {
        version: 0,
        source: 'bundled',
        sources: null,
        getParser: (...args) => bundledParsers().then((m) => m.getParser(...args)),
      };
    });
  }
  return runtimePromise;
}

function sourcePrefs() {
  const defaults = {
    version: SOURCE_PREFS_VERSION,
    installed: DEFAULT_INSTALLED,
    pinned: DEFAULT_PINNED,
  };
  try {
    const raw = localStorage.getItem(SOURCE_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        parsed.version === SOURCE_PREFS_VERSION &&
        Array.isArray(parsed.installed) &&
        Array.isArray(parsed.pinned)
      ) {
        return parsed;
      }
    }
    localStorage.setItem(SOURCE_PREFS_KEY, JSON.stringify(defaults));
  } catch {
    /* ignore corrupt storage */
  }
  return defaults;
}

function saveSourcePrefs(prefs) {
  try {
    localStorage.setItem(SOURCE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage disabled */
  }
}

// Stamp a per-source change time so the cloud sync can do last-write-wins
// (which device most recently installed/uninstalled/pinned this source).
function stampSource(prefs, id) {
  if (!id) return;
  prefs.ts = prefs.ts || {};
  prefs.ts[id] = Date.now();
}

// ── source-pref sync (the user's installed/pinned sources follow their
// account across devices, via the nyora_source_prefs table) ────────────────
// Build upsert rows for sync. Only sources the user EXPLICITLY changed
// (install/uninstall/pin → they carry a per-source timestamp) are pushed, so a
// fresh browser's untouched defaults never clobber the user's real source set
// on another device. Each row carries the source's enabled + pinned flags.
export function sourcePrefRows(userId) {
  const prefs = sourcePrefs();
  const ts = prefs.ts || {};
  const rows = [];
  for (const id of Object.keys(ts)) {
    if (!id) continue;
    rows.push({
      user_id: userId,
      source_id: id,
      is_pinned: prefs.pinned.includes(id),
      is_enabled: prefs.installed.includes(id),
      updated_at: new Date(ts[id]).toISOString(),
    });
  }
  return rows;
}

// Apply pulled rows with per-source last-write-wins. Returns true if anything
// changed locally (so the caller can refresh the Explore source list).
export function applySourcePrefRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const prefs = sourcePrefs();
  prefs.ts = prefs.ts || {};
  let changed = false;
  for (const r of rows) {
    const id = r && r.source_id;
    if (!id) continue;
    const remoteMs = Date.parse(r.updated_at || '') || 0;
    if (remoteMs < (prefs.ts[id] || 0)) continue; // local change is newer — keep it
    const enabled = r.is_enabled !== false;
    const pinned = !!r.is_pinned;
    if (enabled && !prefs.installed.includes(id)) { prefs.installed.push(id); changed = true; }
    if (!enabled && prefs.installed.includes(id)) { prefs.installed = prefs.installed.filter((x) => x !== id); changed = true; }
    if (pinned && !prefs.pinned.includes(id)) { prefs.pinned.push(id); changed = true; }
    if (!pinned && prefs.pinned.includes(id)) { prefs.pinned = prefs.pinned.filter((x) => x !== id); changed = true; }
    if (remoteMs) prefs.ts[id] = remoteMs;
  }
  prefs.pinned = prefs.pinned.filter((id) => prefs.installed.includes(id)); // pins ⊆ installed
  if (changed) saveSourcePrefs(prefs);
  return changed;
}

async function loadSources() {
  if (!sourcesPromise) {
    sourcesPromise = parserRuntime().then(async (runtime) => runtime.sources || (await bundledParsers()).getAllSources());
  }
  return sourcesPromise;
}

function sourceMeta(source, prefs) {
  const installed = prefs.installed.includes(source.id);
  const pinned = prefs.pinned.includes(source.id);
  return {
    id: source.id,
    name: source.title || source.name || source.id,
    title: source.title || source.name || source.id,
    lang: source.locale || source.lang || 'multi',
    baseUrl: `https://${source.domain}`,
    engine: source.family || 'JavaScript',
    contentType: 'Manga',
    isNsfw: !!source.isNsfw,
    canUninstall: true,
    packageName: '',
    sourceCodeUrl: '',
    iconUrl: '',
    version: '1.0.0',
    versionCode: 1,
    isObsolete: false,
    localPath: '',
    installedAt: 0,
    isInstalled: installed,
    isPinned: pinned,
  };
}

async function listedSources() {
  const sources = await loadSources();
  const prefs = sourcePrefs();
  return sources.map((source) => sourceMeta(source, prefs));
}

function parseHTML(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

async function proxyFetch(url, init = {}, parser) {
  let res = await fetch(`${proxyBase()}/proxy?url=${encodeURIComponent(url)}`, init);
  res = await handleProxyRedirect(res, url, init, parser);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text();
}

async function handleProxyRedirect(res, originalUrl, init, parser) {
  const finalUrl = res.headers.get('X-Final-URL');
  if (!finalUrl) return res;
  let finalDomain = '';
  try {
    finalDomain = new URL(finalUrl).hostname;
  } catch {
    return res;
  }
  const original = new URL(originalUrl);
  const redirected = finalUrl !== originalUrl && finalDomain !== original.hostname;
  if (parser && redirected) {
    parser.domain = finalDomain;
  }
  if (!res.ok && redirected) {
    return fetch(`${proxyBase()}/proxy?url=${encodeURIComponent(finalUrl)}`, init);
  }
  return res;
}

const context = {
  httpGet(url, parser) {
    return proxyFetch(url, {}, parser);
  },
  httpPost(url, body, headers = {}, parser) {
    return proxyFetch(url, {
      method: 'POST',
      headers,
      body,
    }, parser);
  },
  parseHTML,
};

// In-memory TTL cache — avoids re-fetching manga site HTML while browsing.
// Keyed by the full request path so page numbers / source IDs are separate entries.
// Intentionally in-memory only (no localStorage) so there's no stale-across-session risk.
const _cache = new Map();
const TTL_LIST    = 3  * 60 * 1000; // browse lists refresh often
const TTL_DETAILS = 15 * 60 * 1000; // manga details change rarely
const TTL_PAGES   = 10 * 60 * 1000; // chapter page URLs are stable per chapter

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.exp) { _cache.delete(key); return undefined; }
  return entry.val;
}

function cacheSet(key, val, ttl) {
  _cache.set(key, { val, exp: Date.now() + ttl });
  return val;
}

function cleanSourceId(sid) {
  let value = String(sid || '').trim();
  if (value.includes('.MangaSourceRef.')) value = value.split('.MangaSourceRef.').pop();
  const up = value.toUpperCase();
  if (up === 'UNKNOWN' || !value) return 'UNKNOWN';
  if (up === 'LOCAL') return 'LOCAL';
  if (value.startsWith('JS_')) return `parser:${value.slice(3)}`;
  if (value.startsWith('parser:') || value.startsWith('script:')) return `parser:${value.slice(value.indexOf(':') + 1)}`;
  return value;
}

async function parserFor(sid) {
  const sourceId = cleanSourceId(sid);
  const runtime = await parserRuntime();

  // First try the direct lookup (works for plain UPPER_SNAKE_CASE ids like "MANGAFIRE_EN").
  let parser = await runtime.getParser(sourceId, context);
  if (parser) return parser;

  // If sourceId carries a "parser:" prefix the stored className (e.g. "parser:MangaDex")
  // does not match the sources.json id (e.g. "MANGADEX").  Build a className→id map from
  // the live sources list and retry with the canonical id.
  if (sourceId.startsWith('parser:') || sourceId.startsWith('script:')) {
    const className = sourceId.slice(sourceId.indexOf(':') + 1);
    const sources = await loadSources();
    const entry = sources.find(
      (s) => s.className === className ||
             (s.className || '').toLowerCase() === className.toLowerCase() ||
             s.id === className.toUpperCase() ||
             s.id === className.replace(/([A-Z])/g, '_$1').toUpperCase().replace(/^_/, '')
    );
    if (entry) {
      parser = await runtime.getParser(entry.id, context);
      if (parser) return parser;
    }
  }

  throw new Error(`Unsupported source: ${sourceId}`);
}

function queryValue(path, key) {
  return new URL(path, window.location.origin).searchParams.get(key);
}

function queryNumber(path, key, fallback) {
  const n = Number(queryValue(path, key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sortOrder(kind) {
  if (kind === 'latest') return SortOrder.UPDATED;
  if (kind === 'search') return SortOrder.RELEVANCE;
  return SortOrder.POPULARITY;
}

function normalizeManga(manga, sourceId) {
  if (!manga) return manga;
  return {
    // Trust the bundle-stamped canonical id (index.js stampIds). The old `|| manga.url`
    // fallback produced non-canonical ids that broke cross-device sync.
    id: manga.id,
    title: manga.title || 'Untitled',
    altTitles: manga.altTitles || [],
    url: manga.url,
    publicUrl: manga.publicUrl || manga.url,
    rating: typeof manga.rating === 'number' ? manga.rating : -1,
    isNsfw: manga.isNsfw === true || manga.contentRating === 'ADULT',
    contentRating: manga.contentRating || 'SAFE',
    coverUrl: manga.coverUrl || '',
    largeCoverUrl: manga.largeCoverUrl || manga.coverUrl || '',
    state: manga.state || null,
    authors: manga.authors || [],
    source: manga.source || { type: 'Script', name: sourceId },
    description: manga.description || '',
    tags: manga.tags || [],
    chapters: manga.chapters || [],
  };
}

function normalizeChapter(chapter, index) {
  return {
    id: chapter.id,
    title: chapter.title || `Chapter ${chapter.number || index + 1}`,
    number: Number(chapter.number) || index + 1,
    volume: Number(chapter.volume) || 0,
    url: chapter.url,
    scanlator: chapter.scanlator || '',
    uploadDate: chapter.uploadDate || 0,
    branch: chapter.branch || '',
    pages: chapter.pages || [],
    index,
  };
}

function normalizePages(pages, parser) {
  return (pages || [])
    .filter((page) => page && page.url)
    .map((page) => ({
      url: page.url && page.url.startsWith('/') && parser ? parser.toAbsoluteUrl(page.url) : page.url,
      preview: page.preview || '',
      headers: page.headers || {},
    }));
}

async function sourceList(path, kind) {
  const cached = cacheGet(path);
  if (cached) return cached;
  const id = queryValue(path, 'id');
  const page = queryNumber(path, 'page', 1);
  const q = queryValue(path, 'q') || '';
  const parser = await parserFor(id);
  const entries = await parser.getListPage(page, sortOrder(kind), { query: kind === 'search' ? q : '' });
  return cacheSet(path, {
    entries: entries.map((manga) => normalizeManga(manga, id)),
    hasNextPage: entries.length > 0,
  }, TTL_LIST);
}

async function details(path) {
  const cached = cacheGet(path);
  if (cached) return cached;
  const id = queryValue(path, 'id');
  const url = queryValue(path, 'url');
  const parser = await parserFor(id);
  const manga = await parser.getDetails({ id: url, url, title: '' });
  const normalized = normalizeManga(manga, id);
  const chapters = (normalized.chapters || []).map(normalizeChapter);
  normalized.chapters = chapters;
  return cacheSet(path, { manga: normalized, chapters }, TTL_DETAILS);
}

async function pages(path) {
  const cached = cacheGet(path);
  if (cached) return cached;
  const id = queryValue(path, 'id');
  const url = queryValue(path, 'url');
  const parser = await parserFor(id);
  const pageList = await parser.getPages({ id: url, url });
  return cacheSet(path, { pages: normalizePages(pageList, parser) }, TTL_PAGES);
}

async function globalSearch(path) {
  const q = queryValue(path, 'q') || '';
  const limit = queryNumber(path, 'limit', 5);
  const sources = (await listedSources()).filter((source) => source.isInstalled).slice(0, 12);
  const groups = [];
  for (const source of sources) {
    try {
      const result = await sourceList(`/sources/search?id=${encodeURIComponent(source.id)}&q=${encodeURIComponent(q)}&page=1`, 'search');
      groups.push({
        sourceId: source.id,
        sourceName: source.name,
        entries: result.entries.slice(0, limit),
        error: null,
      });
    } catch (e) {
      groups.push({
        sourceId: source.id,
        sourceName: source.name,
        entries: [],
        error: String(e && e.message ? e.message : e),
      });
    }
  }
  return { query: q, groups };
}

/** Returns current OTA/bundled parser status. Resolves once the runtime is ready. */
export async function otaStatus() {
  const rt = await parserRuntime();
  return {
    source: rt.source,
    version: rt.version,
    manifestUrl: localStorage.getItem(OTA_MANIFEST_URL_KEY) || DEFAULT_OTA_BASE + '/manifest.json',
    customBase: localStorage.getItem(OTA_BASE_KEY) || '',
  };
}

/** Resets the runtime promise so the next call loads fresh (OTA re-check on next use). */
export function resetRuntime() {
  runtimePromise = null;
}

export function imageUrl(url, headers) {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (url.startsWith('/')) return url;
  const absUrl = url.startsWith('//') ? 'https:' + url : url;
  // Route images through the always-on Cloudflare Worker /image proxy (same
  // worker as parser fetches), NOT the same-origin /image which Netlify rewrites
  // to the Render backend (free tier → ~30s cold starts → blank covers/pages).
  // The worker applies the h=Name:Value headers (Referer/UA) and sends ACAO:*.
  let result = `${proxyBase()}/image?u=${encodeURIComponent(absUrl)}`;
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      result += `&h=${encodeURIComponent(k + ':' + v)}`;
    }
  }
  return result;
}

export async function handle(path, method = 'GET', body) {
  const route = String(path || '').split('?')[0];
  if (route === '/health') {
    const runtime = await parserRuntime();
    return {
      status: 'ok',
      runtime: runtime.source === 'ota' ? 'ota-js-parsers' : 'embedded-js-parsers',
      parserVersion: runtime.version,
    };
  }
  if (route === '/sources') return { sources: await listedSources() };
  if (route === '/sources/catalog') {
    const entries = (await listedSources()).map((source) => ({
      id: source.id,
      name: source.name,
      lang: source.lang,
      engine: source.engine,
      contentType: source.contentType,
      isBroken: false,
      isInstalled: source.isInstalled,
    }));
    return { entries };
  }
  if (route === '/sources/install') {
    const id = queryValue(path, 'id');
    const prefs = sourcePrefs();
    if (id && !prefs.installed.includes(id)) prefs.installed.push(id);
    stampSource(prefs, id);
    saveSourcePrefs(prefs);
    return { source: (await listedSources()).find((source) => source.id === id) || null };
  }
  if (route === '/sources/uninstall') {
    const id = queryValue(path, 'id');
    const prefs = sourcePrefs();
    prefs.installed = prefs.installed.filter((item) => item !== id);
    prefs.pinned = prefs.pinned.filter((item) => item !== id);
    stampSource(prefs, id);
    saveSourcePrefs(prefs);
    return { source: (await listedSources()).find((source) => source.id === id) || null };
  }
  if (route === '/sources/pin') {
    const id = queryValue(path, 'id');
    const prefs = sourcePrefs();
    prefs.pinned = prefs.pinned.includes(id)
      ? prefs.pinned.filter((item) => item !== id)
      : prefs.pinned.concat(id);
    stampSource(prefs, id);
    saveSourcePrefs(prefs);
    return { sources: await listedSources() };
  }
  if (route === '/sources/filters') return { filters: [] };
  if (route === '/sources/popular') return sourceList(path, 'popular');
  if (route === '/sources/latest') return sourceList(path, 'latest');
  if (route === '/sources/search') return sourceList(path, 'search');
  if (route === '/manga/details' || route === '/sources/details') return details(path);
  if (route === '/manga/pages' || route === '/sources/pages') return pages(path);
  if (route === '/search/global') return globalSearch(path);
  if (route === '/suggestions') return { entries: [] };
  if (route === '/manga/alternatives') return { entries: [] };
  if (route === '/downloads' || route.startsWith('/downloads/')) {
    return { entries: [], settings: { maxConcurrentDownloads: 2, format: 'CBZ' } };
  }
  if (route === '/settings/network') return { settings: { parserProxyUrl: proxyBase() } };
  if (body && method !== 'GET') return body;
  return null;
}
