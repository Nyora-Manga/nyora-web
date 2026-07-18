// screens/discover.js — android-style Discover home.
//
// Mirrors the nyora-android Discover screen (and the iOS Discover): a top search
// bar, a HERO card built from the #1 trending manga (cover backdrop + title +
// genres + a Read button), a "Trending now" horizontal rail with a "Show all",
// and an "All-time popular" horizontal rail with a "Show all".
//
// The feed comes from AniList's public GraphQL API (https://graphql.anilist.co)
// with NO auth — a single POST fetches both the TRENDING_DESC and
// POPULARITY_DESC pages via aliased Page queries. AniList sends permissive CORS
// headers so the browser allows this cross-origin call directly (the same
// exception suggestions.js relies on); AniList's CDN covers/banners load with no
// proxy either.
//
// Tapping any entry — a rail card OR the hero Read button — runs a universal
// search across the user's installed sources (router.navigate('search', {q})),
// which resolves the AniList title against whatever sources are installed and
// opens it. "Show all" jumps to the full AniList grid (suggestions).
//
// A cached feed paints INSTANTLY (no skeleton, no await) and revalidates in the
// background; only a genuinely cold start shows hero/rail skeletons. A failed
// cold fetch lands on an inline errorBox with Retry. A per-render token guards
// against a slow response from a previous view painting over a newer one.

import {
  el, skeletonCard, errorBox, emptyState,
  sectionHeader, chip, btn, applyImage,
} from '../core/ui.js';
import { router } from '../core/store.js';

export const meta = {
  title: 'Discover',
  nav: true,
  icon: 'home',
  order: 0,
};

// Discover is backed by AniList's public GraphQL API — no auth, permissive CORS,
// real trending/popularity, and recognizable titles. `countryOfOrigin` splits the
// same MANGA type into manga (JP), manhwa (KR) and manhua (CN). AniList media is
// already the exact shape the hero/rail renderers consume, so no normalization.
const ANILIST_API = 'https://graphql.anilist.co';
const MEDIA_FIELDS = 'id title { romaji english native } '
  + 'coverImage { large extraLarge } bannerImage genres averageScore countryOfOrigin';

// Bump on every render() so a slow fetch from a previous view can't overwrite
// the screen after the user has navigated away and back.
let renderToken = 0;

export function render(view, _params) {
  view.replaceChildren();

  const root = el('section', { class: 'discover' });
  view.append(root);

  const body = el('div', { class: 'discover-body' });
  root.append(body);

  load(body);
}

async function load(body, { forceRefresh = false } = {}) {
  const token = ++renderToken;

  // Stale-while-revalidate. Anything cached within FEED_MAX_AGE paints NOW,
  // synchronously — no skeleton, no await, no network on the critical path.
  // If it's past FEED_TTL we still refresh underneath and swap the content in
  // when it lands, so the user sees instant content that is also current.
  const cached = forceRefresh ? null : cachedFeed();
  if (cached) {
    paint(body, cached, token);
    if (feedIsFresh()) return;
    try {
      const fresh = await fetchAnilistFeed();
      // Only repaint if this view is still on screen AND something changed —
      // a needless replaceChildren would scroll rails back to the start under
      // someone who is already browsing them.
      if (token === renderToken && feedNonEmpty(fresh) && !sameFeed(fresh, cached)) paint(body, fresh, token);
    } catch { /* stale content is already on screen — nothing to report */ }
    return;
  }

  // Nothing cached: first ever visit (or cache cleared) — skeletons it is.
  body.replaceChildren(
    heroSkeleton(),
    railSkeleton('Trending now'),
    railSkeleton('All-time popular'),
    railSkeleton('Top rated'),
    railSkeleton('Manhwa'),
  );

  let feed;
  try {
    feed = await fetchAnilistFeed();
  } catch (err) {
    if (token !== renderToken) return;
    body.replaceChildren(
      errorBox("Couldn't load discovery right now."),
      el('div', { class: 'center', style: { marginTop: '14px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(body, { forceRefresh: true }) }),
      ),
    );
    return;
  }

  if (token !== renderToken) return;

  const { trending } = feed;
  const anyContent = Object.values(feed).some((arr) => Array.isArray(arr) && arr.length);
  if (!anyContent) {
    body.replaceChildren(
      emptyState('Nothing to discover right now — check back soon.', 'trending'),
      el('div', { class: 'center', style: { marginTop: '14px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(body, { forceRefresh: true }) }),
      ),
    );
    return;
  }

  paint(body, feed, token);
}

// Cheap identity check so a background revalidate that returns the same ranking
// doesn't tear down and rebuild the DOM under the user.
function sameFeed(a, b) {
  const ids = (f) => Object.keys(f).sort().map((k) => (
    Array.isArray(f[k]) ? k + ':' + f[k].map((m) => m && m.id).join(',') : '')).join('|');
  try { return ids(a) === ids(b); } catch { return false; }
}

function paint(body, feed, token) {
  if (token !== renderToken) return;
  const trending = feed.trending || [];
  const children = [];
  if (trending.length) children.push(heroCard(trending[0]));
  // Ordered rails — each is skipped if AniList returned nothing for it.
  const rails = [
    ['Trending now', 'trending', trending.slice(1)],
    ['Popular manhwa', 'book', feed.manhwa],
    ['Popular manhua', 'book', feed.manhua],
    ['Popular manga', 'stats', feed.manga],
    ['Action', 'play', feed.action],
    ['Romance', 'heart', feed.romance],
    ['Fantasy', 'compass', feed.fantasy],
  ];
  for (const [title, iconName, items] of rails) {
    if (items && items.length) children.push(rail(title, iconName, items));
  }
  body.replaceChildren(...children);
}

// Keep only entries with a real cover (the renderers need one).
function mediaUsable(m) {
  return m && m.coverImage && (m.coverImage.extraLarge || m.coverImage.large);
}

// Build the whole Discover feed in ONE AniList GraphQL request: currently-trending
// across all formats (hero + first rail), plus popularity-ranked manhwa (KR),
// manhua (CN) and manga (JP) rails, and a few trending-by-genre rails. This
// surfaces recognizable, current titles (Solo Leveling, Nano Machine, …), not
// obscure or decades-old entries.

// AniList's public API is capped at ~30 requests/min. To keep AniList as the REAL
// source of Discover (instead of tripping the limit and silently degrading), the
// whole feed is cached in-memory + localStorage and served stale-while-revalidate:
// under FEED_TTL it's used as-is with no request at all; between TTL and
// FEED_MAX_AGE it paints immediately and refreshes in the background. When
// AniList is rate-limited we keep showing the cached feed rather than falling
// back. MangaBaka is only a last resort if AniList has never answered.
const FEED_TTL = 15 * 60 * 1000;          // considered fresh — no refetch at all
const FEED_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // still worth SHOWING while we revalidate
// localStorage, not sessionStorage: session storage dies with the tab, so every
// returning visitor paid a cold AniList round trip and stared at skeletons. The
// feed is public, non-personal ranking data — persisting it is what makes
// Discover instant on second and later visits.
const FEED_CACHE_KEY = 'nyora.discover.feed.v2';
let feedCache = null; // { at:number, feed }

function feedNonEmpty(f) { return !!(f && Array.isArray(f.trending) && f.trending.length); }

function readFeedCache() {
  if (feedCache) return feedCache;
  try {
    const raw = localStorage.getItem(FEED_CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    if (obj && typeof obj.at === 'number' && feedNonEmpty(obj.feed)) { feedCache = obj; return obj; }
  } catch { /* private mode / bad JSON — ignore */ }
  return null;
}
function writeFeedCache(feed, at) {
  feedCache = { at, feed };
  try { localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(feedCache)); } catch { /* ignore quota */ }
}

// Cached feed good enough to paint immediately, or null. Kept separate from the
// fetch so load() can render it synchronously — awaiting even a resolved promise
// costs a frame and reintroduces the skeleton flash we're removing.
export function cachedFeed() {
  const c = readFeedCache();
  return c && (Date.now() - c.at) < FEED_MAX_AGE ? c.feed : null;
}
export function feedIsFresh() {
  const c = readFeedCache();
  return !!c && (Date.now() - c.at) < FEED_TTL;
}

// AniList is PRIMARY. Fresh cache → served instantly; live fetch → cached; on a
// rate-limit/outage we reuse ANY cached AniList feed before touching MangaBaka.
async function fetchAnilistFeed() {
  const cached = readFeedCache();
  if (cached && (Date.now() - cached.at) < FEED_TTL) return cached.feed;

  try {
    const feed = await fetchFromAniList();
    if (feedNonEmpty(feed)) { writeFeedCache(feed, Date.now()); return feed; }
  } catch {
    // Rate-limited or offline — a stale AniList feed still beats MangaBaka.
    if (cached) return cached.feed;
  }
  if (cached) return cached.feed;
  try {
    return await fetchFromMangaBaka();
  } catch {
    return { trending: [], manhwa: [], manhua: [], manga: [], action: [], romance: [], fantasy: [] };
  }
}

async function fetchFromAniList() {
  const page = (alias, filter, sort) =>
    `${alias}: Page(perPage: 30) { media(type: MANGA, isAdult: false, ${filter}sort: ${sort}) { ${MEDIA_FIELDS} } }`;
  const query = `query {
    ${page('trending', '', 'TRENDING_DESC')}
    ${page('manhwa', 'countryOfOrigin: KR, ', 'POPULARITY_DESC')}
    ${page('manhua', 'countryOfOrigin: CN, ', 'POPULARITY_DESC')}
    ${page('manga', 'countryOfOrigin: JP, ', 'POPULARITY_DESC')}
    ${page('action', 'genre: "Action", ', 'TRENDING_DESC')}
    ${page('romance', 'genre: "Romance", ', 'TRENDING_DESC')}
    ${page('fantasy', 'genre: "Fantasy", ', 'TRENDING_DESC')}
  }`;
  const res = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  const d = (json && json.data) || {};
  const pick = (k) => (((d[k] && d[k].media) || []).filter(mediaUsable));
  return {
    trending: pick('trending'),
    manhwa: pick('manhwa'),
    manhua: pick('manhua'),
    manga: pick('manga'),
    action: pick('action'),
    romance: pick('romance'),
    fantasy: pick('fantasy'),
  };
}

// ---- MangaBaka fallback (only used when AniList is unreachable) -------------
const MB_SEARCH = 'https://api.mangabaka.dev/v1/series/search';
const MB_TOKENS = ['a', 'e', 'o', 'the'];
const MB_TYPES = ['manga', 'manhwa', 'manhua'];

function mbCover(it) {
  const c = (it && it.cover) || {};
  return (c.x350 && c.x350.x1) || (c.x250 && c.x250.x1) || (c.raw && c.raw.url) || '';
}
function mbUsable(x) {
  return x && x.state !== 'merged' && mbCover(x) && String(x.title || '').trim().length >= 3;
}
// Publication year is the real recency signal (last_updated_at is just re-index time).
function mbRecency(it) {
  const y = Number(it && it.year);
  const year = (y >= 1900 && y < 3000) ? y : 0;
  const ms = it && it.last_updated_at ? (Date.parse(it.last_updated_at) || 0) : 0;
  return year * 1e13 + ms;
}
// Map a MangaBaka series onto the AniList-media shape the renderers expect.
function normalizeMB(it) {
  const title = it.title || it.romanized_title || it.native_title || 'Untitled';
  const cover = mbCover(it);
  return {
    id: it.id,
    title: { romaji: it.romanized_title || title, english: title },
    coverImage: { large: cover, extraLarge: cover },
    bannerImage: null,
    genres: (Array.isArray(it.genres) ? it.genres : []).slice(0, 6),
    averageScore: typeof it.rating === 'number' ? Math.round(it.rating) : null,
  };
}
async function mbSearchRaw(q, type) {
  const p = new URLSearchParams({ q, content_rating: 'safe', limit: '60' });
  if (type) p.set('type', type);
  const res = await fetch(`${MB_SEARCH}?${p.toString()}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (Array.isArray(json && json.data) ? json.data : []).filter(mbUsable);
}
// Broad pool across all three formats, deduped, ranked by recency, sliced to rails.
async function fetchFromMangaBaka() {
  const reqs = [];
  for (const type of MB_TYPES) for (const q of MB_TOKENS) reqs.push(mbSearchRaw(q, type).catch(() => []));
  const batches = await Promise.all(reqs);
  const seen = new Set();
  const pool = [];
  for (const arr of batches) for (const it of arr) if (it && !seen.has(it.id)) { seen.add(it.id); pool.push(it); }
  if (!pool.length) throw new Error('MangaBaka returned nothing');
  pool.sort((a, b) => mbRecency(b) - mbRecency(a));
  const ofType = (t, n = 22) => pool.filter((x) => x.type === t).slice(0, n).map(normalizeMB);
  const ofGenre = (g, n = 22) => pool
    .filter((x) => (Array.isArray(x.genres) ? x.genres : [])
      .some((gg) => String(gg).toLowerCase().includes(g.toLowerCase())))
    .slice(0, n).map(normalizeMB);
  return {
    trending: pool.slice(0, 24).map(normalizeMB),
    manhwa: ofType('manhwa'),
    manhua: ofType('manhua'),
    manga: ofType('manga'),
    action: ofGenre('Action'),
    romance: ofGenre('Romance'),
    fantasy: ofGenre('Fantasy'),
  };
}

function anilistTitle(item) {
  const t = item && item.title;
  return (t && (t.english || t.romaji)) || 'Untitled';
}

// Open an entry: universal search across installed sources for its title.
function openEntry(item) {
  router.navigate('search', { q: anilistTitle(item) });
}

// ---- hero --------------------------------------------------------------

function heroCard(item) {
  const title = anilistTitle(item);
  const cover = (item.coverImage && (item.coverImage.extraLarge || item.coverImage.large)) || '';
  const banner = item.bannerImage || cover;
  const genres = (Array.isArray(item.genres) ? item.genres : []).slice(0, 3);
  const score = typeof item.averageScore === 'number' ? item.averageScore : null;

  const bg = el('div', { class: 'discover-hero-bg' });
  if (banner) bg.style.backgroundImage = `url("${banner}")`;

  const coverWrap = el('div', { class: 'discover-hero-cover' });
  if (cover) {
    const img = el('img', { loading: 'eager', decoding: 'async', fetchpriority: 'high', alt: title });
    // AniList CDN is CORS-friendly — load directly, fall back to the proxy.
    applyImage(img, cover, undefined, () => { img.style.display = 'none'; });
    coverWrap.appendChild(img);
  }

  const chips = [];
  if (score != null) chips.push(chip(`${score}%`, { class: 'status-completed' }));
  for (const g of genres) chips.push(chip(g));

  const info = el('div', { class: 'discover-hero-info' },
    el('div', { class: 'discover-hero-eyebrow' }, 'Trending'),
    el('h1', { class: 'discover-hero-title', title }, title),
    chips.length ? el('div', { class: 'chips' }, ...chips) : null,
    el('div', { class: 'discover-hero-actions' },
      btn('Read', { variant: 'accent', icon: 'play', onClick: () => openEntry(item) }),
    ),
  );

  const node = el('div', { class: 'discover-hero' },
    bg,
    el('div', { class: 'discover-hero-content' }, coverWrap, info),
  );
  node.addEventListener('click', (e) => {
    // Let the explicit Read button handle its own click.
    if (e.target.closest('.btn')) return;
    openEntry(item);
  });
  return node;
}

// ---- rails -------------------------------------------------------------

function rail(title, iconName, items) {
  const track = el('div', { class: 'discover-rail-track' });
  for (const item of items) track.appendChild(railCard(item));
  return el('div', { class: 'discover-rail' },
    sectionHeader(title,
      btn('Show all', { variant: 'ghost', onClick: () => router.navigate('suggestions') }),
    ),
    track,
  );
}

function railCard(item) {
  const title = anilistTitle(item);
  const cover = (item.coverImage && (item.coverImage.large || item.coverImage.extraLarge)) || '';
  const genre = Array.isArray(item.genres) && item.genres.length ? item.genres[0] : null;

  const coverWrap = el('div', { class: 'cover' });
  if (cover) {
    const img = el('img', { loading: 'lazy', decoding: 'async', alt: title });
    applyImage(img, cover, undefined, () => { img.style.display = 'none'; });
    coverWrap.appendChild(img);
  }
  if (genre) {
    coverWrap.appendChild(el('div', { class: 'chips cover-chips' }, chip(genre)));
  }

  const node = el('md-elevated-card', { class: 'card discover-rail-card', role: 'button', tabindex: '0' },
    el('div', { class: 'card-body' },
      coverWrap,
      el('div', { class: 'title', title }, title),
    ),
  );
  node.addEventListener('click', () => openEntry(item));
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEntry(item); }
  });
  return node;
}

// ---- skeletons ---------------------------------------------------------

function heroSkeleton() {
  return el('div', { class: 'discover-hero skeleton' },
    el('div', { class: 'discover-hero-content' },
      el('div', { class: 'discover-hero-cover skeleton' }),
      el('div', { class: 'discover-hero-info' },
        el('div', { class: 'title skeleton', style: { height: '28px', width: '60%' } }),
        el('div', { class: 'title skeleton', style: { height: '16px', width: '40%', marginTop: '10px' } }),
      ),
    ),
  );
}

function railSkeleton(title) {
  const track = el('div', { class: 'discover-rail-track' });
  for (let i = 0; i < 6; i++) track.appendChild(skeletonCard('discover-rail-card'));
  return el('div', { class: 'discover-rail' },
    sectionHeader(title),
    track,
  );
}
