// Nyora Web — tracker integration.
//
// Six services (AniList, MyAnimeList, Shikimori, Bangumi, MangaBaka, Kitsu) run
// entirely through the nyora-shared helper at NYORA_HELPER_URL (api.nyora.xyz):
// the helper does the OAuth token exchange and the search/scrobble calls
// server-side, so the browser never hits CORS and never sees a client secret.
//
//   • OAuth services: open /tracker/<slug>/authorize in a popup; the helper
//     redirects to the provider, handles the callback, and postMessages the
//     token back here.
//   • Kitsu: POST /tracker/kitsu/login (password grant, no popup).
//   • search/scrobble: /tracker/<slug>/{search,scrobble} with the token as a
//     Bearer header.
//
// Tokens + per-manga links live in localStorage under `nyora.trackers`.

const HELPER = String(globalThis.NYORA_HELPER_URL || 'https://api.nyora.xyz').replace(/\/+$/, '');
const HELPER_ORIGIN = (() => { try { return new URL(HELPER).origin; } catch { return ''; } })();
const STORE_KEY = 'nyora.trackers';

export const TRACKERS = [
  { slug: 'anilist', name: 'AniList', auth: 'oauth' },
  { slug: 'myanimelist', name: 'MyAnimeList', auth: 'oauth' },
  { slug: 'mangabaka', name: 'MangaBaka', auth: 'oauth' },
  { slug: 'kitsu', name: 'Kitsu', auth: 'password' },
];

function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
}
function saveStore(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* quota */ } }
function entry(slug) { return loadStore()[slug] || {}; }
function setEntry(slug, patch) {
  const s = loadStore();
  s[slug] = Object.assign({}, s[slug], patch);
  saveStore(s);
}

export function trackerName(slug) { return (TRACKERS.find((t) => t.slug === slug) || {}).name || slug; }
export function isConnected(slug) { return !!entry(slug).access_token; }
export function isEnabled(slug) { const e = entry(slug); return !!e.access_token && e.enabled !== false; }
export function setEnabled(slug, on) { setEntry(slug, { enabled: !!on }); }
export function token(slug) { return entry(slug).access_token || ''; }
export function disconnect(slug) { const s = loadStore(); delete s[slug]; saveStore(s); }

// Map the helper's terse error codes to something a human can act on.
function oauthErrorMessage(code) {
  const m = {
    access_denied: 'You declined the authorization.',
    no_code: 'The tracker didn’t return an authorization code — try again.',
    bad_state: 'Sign-in expired or didn’t match — try again.',
    exchange_failed: 'Couldn’t reach the tracker to finish sign-in.',
    bad_token_response: 'The tracker returned an unexpected response.',
    no_access_token: 'The tracker didn’t return an access token.',
  };
  return (code && m[code]) || (code ? `Sign-in failed (${code}).` : 'No token returned.');
}

// OAuth popup login. We pass our own origin as `ro` so the helper's callback
// relays the token back through THIS origin (oauth.html → BroadcastChannel):
// some providers (e.g. MangaBaka) send Cross-Origin-Opener-Policy, which nulls
// window.opener and breaks a plain cross-origin postMessage. We still listen for
// postMessage too, as a fast path for providers that don't set COOP.
export function connectOAuth(slug) {
  return new Promise((resolve, reject) => {
    const popup = window.open(
      `${HELPER}/tracker/${slug}/authorize?ro=${encodeURIComponent(location.origin)}`,
      `nyora-track-${slug}`,
      'width=520,height=680,menubar=no,toolbar=no',
    );
    if (!popup) { reject(new Error('Popup blocked — allow popups for this site and retry.')); return; }
    let done = false;
    let bc = null;
    try { bc = new BroadcastChannel('nyora-tracker'); } catch { /* older browser */ }

    function handle(d) {
      if (done || !d || d.source !== 'nyora-tracker' || d.slug !== slug) return;
      cleanup();
      if (d.error || !d.access_token) { reject(new Error(oauthErrorMessage(d.error))); return; }
      setEntry(slug, { access_token: d.access_token, refresh_token: d.refresh_token || '', enabled: true });
      resolve(true);
    }
    // The relay page is same-origin; the legacy direct page is the helper origin.
    function onMsg(ev) { if (ev.origin === location.origin || ev.origin === HELPER_ORIGIN) handle(ev.data); }
    function onStorage(ev) {
      if (ev.key !== 'nyora.oauth.msg' || !ev.newValue) return;
      try { handle(JSON.parse(ev.newValue)); } catch { /* ignore */ }
    }
    function cleanup() {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      window.removeEventListener('storage', onStorage);
      if (bc) { try { bc.close(); } catch { /* ignore */ } }
      clearInterval(poll);
      clearTimeout(timer);
      try { popup.close(); } catch { /* ignore */ }
    }
    if (bc) bc.onmessage = (ev) => handle(ev.data);
    window.addEventListener('message', onMsg);
    window.addEventListener('storage', onStorage);
    const poll = setInterval(() => { if (popup.closed && !done) { cleanup(); reject(new Error('Sign-in cancelled.')); } }, 700);
    const timer = setTimeout(() => { cleanup(); reject(new Error('Sign-in timed out.')); }, 300000);
  });
}

// Kitsu resource-owner password grant (no popup).
export async function connectPassword(slug, username, password) {
  const res = await fetch(`${HELPER}/tracker/${slug}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error || 'Login failed — check your email and password.');
  setEntry(slug, { access_token: data.access_token, refresh_token: data.refresh_token || '', enabled: true });
  return true;
}

export function connect(slug, opts) {
  const t = TRACKERS.find((x) => x.slug === slug);
  if (t && t.auth === 'password') return connectPassword(slug, (opts || {}).username, (opts || {}).password);
  return connectOAuth(slug);
}

export async function search(slug, title) {
  const res = await fetch(`${HELPER}/tracker/${slug}/search?title=${encodeURIComponent(title)}`, {
    headers: { Authorization: `Bearer ${token(slug)}` },
  });
  if (!res.ok) throw new Error(`${slug} search failed (${res.status})`);
  const data = await res.json().catch(() => ({}));
  return data.results || [];
}

async function scrobbleOne(slug, mediaId, progress) {
  const url = `${HELPER}/tracker/${slug}/scrobble?mediaId=${encodeURIComponent(mediaId)}`
    + `&progress=${encodeURIComponent(progress)}&status=reading`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token(slug)}` } });
  return res.ok;
}

/** Manually link a manga to a tracker's media id (from a search result). */
export function link(slug, mangaId, mediaId) {
  const e = entry(slug);
  const links = Object.assign({}, e.links);
  links[String(mangaId)] = mediaId;
  setEntry(slug, { links });
}

/** The remote media id this manga is linked to on `slug`, or null. */
export function linkedMediaId(slug, mangaId) {
  return (entry(slug).links || {})[String(mangaId)] ?? null;
}

/** Forget the local link (the remote entry itself is left untouched). */
export function unlink(slug, mangaId) {
  const e = entry(slug);
  const links = Object.assign({}, e.links);
  delete links[String(mangaId)];
  setEntry(slug, { links });
}

/** The trackers the user is currently signed in to. */
export function connectedTrackers() {
  return TRACKERS.filter((t) => isConnected(t.slug));
}

/** Current tracking state for a linked media id, or null if not tracked. */
export async function getState(slug, mediaId) {
  try {
    const res = await fetch(`${HELPER}/tracker/${slug}/state?mediaId=${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${token(slug)}` },
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d && d.linked ? d : null;
  } catch { return null; }
}

/** Update status / progress / score for a linked media id. `score` is 0..1. */
export async function setState(slug, mediaId, { status, progress, score } = {}) {
  const p = new URLSearchParams({ mediaId: String(mediaId) });
  if (status != null) p.set('status', status);
  if (progress != null) p.set('progress', String(progress));
  if (score != null) p.set('rating', String(score));
  const res = await fetch(`${HELPER}/tracker/${slug}/scrobble?${p.toString()}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token(slug)}` },
  });
  return res.ok;
}

/**
 * Best-effort progress sync to every connected + enabled tracker. Resolves the
 * remote media id once per manga (cached by mangaId, else search-by-title →
 * first hit) then scrobbles the chapter. Each tracker is independent and fails
 * silently, so one unreachable service never blocks the others.
 */
const _lastScrobble = Object.create(null);

export async function scrobbleAll({ mangaId, title, chapter }) {
  if (!mangaId || !title) return;
  const progress = Math.max(1, Math.floor(Number(chapter) || 0) || 1);
  // recordHistory fires on every page turn — only hit the network once per
  // (manga, chapter) per session.
  const dedupeKey = `${mangaId}${progress}`;
  if (_lastScrobble[mangaId] === dedupeKey) return;
  _lastScrobble[mangaId] = dedupeKey;
  for (const t of TRACKERS) {
    if (!isEnabled(t.slug)) continue;
    try {
      let mediaId = (entry(t.slug).links || {})[String(mangaId)];
      if (mediaId == null) {
        const hits = await search(t.slug, title);
        if (!hits.length) continue;
        mediaId = hits[0].id;
        link(t.slug, mangaId, mediaId);
      }
      await scrobbleOne(t.slug, mediaId, progress);
    } catch { /* ignore per-tracker failure */ }
  }
}

export default {
  TRACKERS, trackerName, isConnected, isEnabled, setEnabled, disconnect,
  connect, connectOAuth, connectPassword, search, link, linkedMediaId, unlink,
  connectedTrackers, getState, setState, scrobbleAll,
};
