// ── source preferences (installed / pinned) + cross-device sync ─────────────
//
// The in-browser web-parsers (web-parsers/*.js) were removed: all catalog,
// browse, details and page content is served by the hosted helper
// (api.hasanraza.tech), which the reader and Explore already use. This module
// is now just the client-side source-preference store plus its account sync,
// and a small `handle()` shim for the few local mutation routes.

const SOURCE_PREFS_KEY = 'nyora.webParser.sources';
const SOURCE_PREFS_VERSION = 5;
const HELPER_URL = ((typeof globalThis !== 'undefined' && globalThis.NYORA_HELPER_URL) || 'https://api.hasanraza.tech').replace(/\/+$/, '');
const DEFAULT_PINNED = ['ASURASCANS_US', 'MANGANATO_GG', 'NYXSCANS', 'DANKE', 'VORTEXSCANS'];
const DEFAULT_INSTALLED = ['ASURASCANS_US', 'MANGANATO_GG', 'NYXSCANS', 'DANKE', 'VORTEXSCANS', 'TOONGOD'];

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

function queryValue(path, key) {
  return new URL(path, window.location.origin).searchParams.get(key);
}

// Local mutation shim for api.js's post()/del() fallback. Content routes
// (catalog/browse/details/pages) are served by the hosted helper and never
// reach here; this only persists the local source-pref changes + stamps them
// for sync, and answers a few harmless metadata routes. Anything else returns
// null so api.js falls through to its own handling.
export async function handle(path, method = 'GET', body) {
  const route = String(path || '').split('?')[0];
  if (route === '/health') {
    return { status: 'ok', runtime: 'hosted-helper' };
  }
  if (route === '/sources/install') {
    const id = queryValue(path, 'id');
    const prefs = sourcePrefs();
    if (id && !prefs.installed.includes(id)) prefs.installed.push(id);
    stampSource(prefs, id);
    saveSourcePrefs(prefs);
    return { ok: true };
  }
  if (route === '/sources/uninstall') {
    const id = queryValue(path, 'id');
    const prefs = sourcePrefs();
    prefs.installed = prefs.installed.filter((item) => item !== id);
    prefs.pinned = prefs.pinned.filter((item) => item !== id);
    stampSource(prefs, id);
    saveSourcePrefs(prefs);
    return { ok: true };
  }
  if (route === '/sources/pin') {
    const id = queryValue(path, 'id');
    const prefs = sourcePrefs();
    prefs.pinned = prefs.pinned.includes(id)
      ? prefs.pinned.filter((item) => item !== id)
      : prefs.pinned.concat(id);
    stampSource(prefs, id);
    saveSourcePrefs(prefs);
    return { ok: true };
  }
  if (route === '/sources/filters') return { filters: [] };
  if (route === '/suggestions' || route === '/manga/alternatives') return { entries: [] };
  if (route === '/downloads' || route.startsWith('/downloads/')) {
    return { entries: [], settings: { maxConcurrentDownloads: 2, format: 'CBZ' } };
  }
  if (route === '/settings/network') return { settings: { parserProxyUrl: HELPER_URL } };
  if (body && method !== 'GET') return body;
  return null;
}
