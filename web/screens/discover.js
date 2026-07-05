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

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

// One POST, two aliased pages: trending + all-time popular. The hero pulls
// banner/description/genres from the first trending entry.
const HERO_FIELDS =
  'id title{romaji english} coverImage{large extraLarge} bannerImage genres description(asHtml:false) averageScore';
const CARD_FIELDS = 'id title{romaji english} coverImage{large extraLarge} genres averageScore';
// One POST, many aliased pages → a full Discover feed. isAdult:false keeps it safe.
const ANILIST_QUERY =
  'query{' +
  `trending:Page(perPage:20){media(type:MANGA,sort:TRENDING_DESC,isAdult:false){${HERO_FIELDS}}}` +
  `popular:Page(perPage:18){media(type:MANGA,sort:POPULARITY_DESC,isAdult:false){${CARD_FIELDS}}}` +
  `topRated:Page(perPage:18){media(type:MANGA,sort:SCORE_DESC,isAdult:false){${CARD_FIELDS}}}` +
  `favourites:Page(perPage:18){media(type:MANGA,sort:FAVOURITES_DESC,isAdult:false){${CARD_FIELDS}}}` +
  `manhwa:Page(perPage:18){media(type:MANGA,countryOfOrigin:"KR",sort:POPULARITY_DESC,isAdult:false){${CARD_FIELDS}}}` +
  `action:Page(perPage:18){media(type:MANGA,genre_in:["Action"],sort:POPULARITY_DESC,isAdult:false){${CARD_FIELDS}}}` +
  `romance:Page(perPage:18){media(type:MANGA,genre_in:["Romance"],sort:POPULARITY_DESC,isAdult:false){${CARD_FIELDS}}}` +
  `fantasy:Page(perPage:18){media(type:MANGA,genre_in:["Fantasy"],sort:POPULARITY_DESC,isAdult:false){${CARD_FIELDS}}}` +
  `comedy:Page(perPage:18){media(type:MANGA,genre_in:["Comedy"],sort:POPULARITY_DESC,isAdult:false){${CARD_FIELDS}}}` +
  '}';

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
      errorBox(`Couldn't reach AniList: ${err.message || err}`),
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
      emptyState('AniList has nothing to discover right now — check back soon.', 'trending'),
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

// Direct GraphQL POST — AniList sends permissive CORS headers.
async function fetchAnilistFeed() {
  const res = await fetch(ANILIST_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: ANILIST_QUERY }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const data = (json && json.data) || {};
  const list = (page) => {
    const m = page && page.media;
    return Array.isArray(m) ? m : [];
  };
  return {
    trending: list(data.trending),
    popular: list(data.popular),
    topRated: list(data.topRated),
    favourites: list(data.favourites),
    manhwa: list(data.manhwa),
    action: list(data.action),
    romance: list(data.romance),
    fantasy: list(data.fantasy),
    comedy: list(data.comedy),
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
