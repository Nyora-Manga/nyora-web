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
// Loading paints a hero skeleton + skeleton rails (never a blank screen); a
// failed fetch lands on an inline errorBox with Retry. A per-render token guards
// against a slow response from a previous view painting over a newer one.

import {
  el, skeletonCard, errorBox, emptyState,
  sectionHeader, chip, icon, btn, applyImage,
} from '../core/ui.js';
import { router } from '../core/store.js';

export const meta = {
  title: 'Discover',
  nav: true,
  icon: 'home',
  order: 0,
};

// Discover is backed by the MangaBaka database (https://mangabaka.org). Its API
// is search-first (no trending endpoint) and sends permissive CORS, so we fetch
// several filtered searches straight from the browser and sort them client-side
// by popularity / rating to build the rails.
const MB_SEARCH = 'https://api.mangabaka.dev/v1/series/search';

// A broad query token — MangaBaka search requires `q`, so this matches the bulk
// of the catalogue; we then sort the results ourselves.
const MB_BROAD_Q = 'a';

// Pull the sortable global-popularity number out of MangaBaka's nested shape.
function mbPopularity(it) {
  const p = it && it.popularity && it.popularity.global;
  return (p && typeof p.current === 'number' ? p.current : 0) || 0;
}

// Best available cover: prefer the CDN thumbnails, fall back to the raw image.
function mbCover(it) {
  const c = (it && it.cover) || {};
  return (c.x350 && c.x350.x1) || (c.x250 && c.x250.x1) || (c.raw && c.raw.url) || '';
}

// "school_life" -> "School Life"
function prettyGenre(g) {
  return String(g || '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Map a MangaBaka series onto the shape the hero/rail renderers already expect
// (an AniList-media-like object), so the rest of this screen is unchanged.
function normalizeMB(it) {
  const title = it.title || it.romanized_title || it.native_title || 'Untitled';
  const cover = mbCover(it);
  return {
    id: it.id,
    title: { romaji: it.romanized_title || title, english: title },
    coverImage: { large: cover, extraLarge: cover },
    bannerImage: null,
    genres: (Array.isArray(it.genres) ? it.genres : []).map(prettyGenre).slice(0, 6),
    averageScore: typeof it.rating === 'number' ? Math.round(it.rating) : null,
    description: it.description || '',
  };
}

// Bump on every render() so a slow fetch from a previous view can't overwrite
// the screen after the user has navigated away and back.
let renderToken = 0;

export function render(view, _params) {
  view.replaceChildren();

  const root = el('section', { class: 'discover' });
  view.append(root);

  // Persistent search bar at the top — submits a universal search.
  root.append(discoverSearchBar());

  const body = el('div', { class: 'discover-body' });
  root.append(body);

  load(body);
}

function discoverSearchBar() {
  const input = el('input', {
    type: 'search',
    class: 'discover-search-input',
    placeholder: 'Search all sources',
    autocomplete: 'off',
    enterkeyhint: 'search',
    'aria-label': 'Search all sources',
  });
  const form = el('form', {
    class: 'discover-search',
    role: 'search',
    onSubmit: (e) => {
      e.preventDefault();
      const q = input.value.trim();
      router.navigate('search', q ? { q } : {});
    },
  },
    icon('search'),
    input,
  );
  return form;
}

async function load(body) {
  const token = ++renderToken;

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
      errorBox(`Couldn't reach MangaBaka: ${err.message || err}`),
      el('div', { class: 'center', style: { marginTop: '14px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(body) }),
      ),
    );
    return;
  }

  if (token !== renderToken) return;

  const { trending } = feed;
  const anyContent = Object.values(feed).some((arr) => Array.isArray(arr) && arr.length);
  if (!anyContent) {
    body.replaceChildren(
      emptyState('MangaBaka has nothing to discover right now — check back soon.', 'trending'),
      el('div', { class: 'center', style: { marginTop: '14px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(body) }),
      ),
    );
    return;
  }

  const children = [];
  if (trending.length) children.push(heroCard(trending[0]));
  // Ordered rails — each is skipped if AniList returned nothing for it.
  const rails = [
    ['Trending now', 'trending', trending.slice(1)],
    ['All-time popular', 'stats', feed.popular],
    ['Top rated', 'checkCircle', feed.topRated],
    ['Most favourited', 'heart', feed.favourites],
    ['Popular manhwa', 'book', feed.manhwa],
    ['Action', 'play', feed.action],
    ['Romance', 'heart', feed.romance],
    ['Fantasy', 'compass', feed.fantasy],
    ['Comedy', 'feed', feed.comedy],
  ];
  for (const [title, iconName, items] of rails) {
    if (items && items.length) children.push(rail(title, iconName, items));
  }
  body.replaceChildren(...children);
}

// A MangaBaka series is worth showing only if it has a cover and a real title
// (the DB is full of 1–2 char placeholder entries we don't want on the grid).
function mbUsable(x) {
  return x && x.state !== 'merged' && mbCover(x) && String(x.title || '').trim().length >= 3;
}

// One MangaBaka search → a normalized, quality-filtered, client-side-sorted rail.
async function mbRail({ genre, type = 'manga', sortBy = 'popularity', limit = 30, take = 20 } = {}) {
  const p = new URLSearchParams({
    q: MB_BROAD_Q,
    type,
    content_rating: 'safe',
    limit: String(limit),
  });
  if (genre) p.set('genre', genre);
  const res = await fetch(`${MB_SEARCH}?${p.toString()}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const items = (Array.isArray(json && json.data) ? json.data : []).filter(mbUsable);
  items.sort((a, b) =>
    sortBy === 'rating' ? (b.rating || 0) - (a.rating || 0) : mbPopularity(b) - mbPopularity(a),
  );
  return items.slice(0, take).map(normalizeMB);
}

// Build the whole Discover feed from parallel MangaBaka searches. A single rail
// failing (network/rate) resolves to [] so the rest of the page still renders.
async function fetchAnilistFeed() {
  const safe = (promise) => promise.catch(() => []);
  const [popular, topRated, manhwa, action, romance, fantasy, comedy] = await Promise.all([
    safe(mbRail({ sortBy: 'popularity', limit: 30 })),
    safe(mbRail({ sortBy: 'rating', limit: 30 })),
    safe(mbRail({ type: 'manhwa', sortBy: 'popularity', limit: 30 })),
    safe(mbRail({ genre: 'Action', sortBy: 'popularity', limit: 30 })),
    safe(mbRail({ genre: 'Romance', sortBy: 'popularity', limit: 30 })),
    safe(mbRail({ genre: 'Fantasy', sortBy: 'popularity', limit: 30 })),
    safe(mbRail({ genre: 'Comedy', sortBy: 'popularity', limit: 30 })),
  ]);
  // `trending` drives the hero + first rail (popularity-ranked).
  return { trending: popular, popular: [], topRated, favourites: [], manhwa, action, romance, fantasy, comedy };
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
    const img = el('img', { loading: 'eager', decoding: 'async', alt: title });
    // AniList CDN is CORS-friendly — load directly, fall back to the proxy.
    applyImage(img, cover, undefined, () => { img.style.display = 'none'; });
    coverWrap.appendChild(img);
  }

  const chips = [];
  if (score != null) chips.push(chip(`${score}%`, { class: 'status-completed' }));
  for (const g of genres) chips.push(chip(g));

  const info = el('div', { class: 'discover-hero-info' },
    el('div', { class: 'discover-hero-eyebrow' }, 'Top trending'),
    el('h1', { class: 'discover-hero-title', title }, title),
    chips.length ? el('div', { class: 'chips' }, ...chips) : null,
    el('div', { class: 'discover-hero-actions' },
      btn('Read', { variant: 'accent', icon: 'play', onClick: () => openEntry(item) }),
    ),
  );

  const node = el('div', { class: 'discover-hero', role: 'button', tabindex: '0' },
    bg,
    el('div', { class: 'discover-hero-content' }, coverWrap, info),
  );
  node.addEventListener('click', (e) => {
    // Let the explicit Read button handle its own click.
    if (e.target.closest('.btn')) return;
    openEntry(item);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEntry(item); }
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
    coverWrap.appendChild(el('div', {
      class: 'chips',
      style: { position: 'absolute', left: '6px', right: '6px', bottom: '6px', gap: '6px' },
    }, chip(genre)));
  }

  const node = el('div', { class: 'card discover-rail-card', role: 'button', tabindex: '0' },
    coverWrap,
    el('div', { class: 'title', title }, title),
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
