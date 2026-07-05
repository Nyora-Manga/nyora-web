// screens/suggestions.js — "For You": AniList Trending discovery feed.
//
// Mirrors the nyora-linux SuggestionsScreen: fetch the top TRENDING manga from
// AniList with NO auth via a direct CORS-allowed GraphQL POST to
// https://graphql.anilist.co, then render a premium cover grid (cover, title,
// score chip, lead genre). Tapping a card runs a global search for that title
// (router.navigate('search', { q: title })) so the user can resolve it against
// whichever sources they have installed.
//
// AniList sends permissive CORS headers, so the browser allows this cross-origin
// call directly — no proxy and no server endpoint needed. This is the sole
// cross-origin direct fetch in the SPA; everything else goes through same-origin
// api.js.
//
// Loading shows a skeleton grid (never a blank screen); a failed fetch lands on
// an inline errorBox with a Retry button. Navigation can interrupt the in-flight
// request, so a per-render token guards against a stale response painting over a
// newer view.

import {
  el, skeletonCard, errorBox, emptyState,
  sectionHeader, chip, icon, btn,
} from '../core/ui.js';
import { router } from '../core/store.js';

export const meta = {
  title: 'Discover',
  nav: true,
  icon: 'trending',
  order: 5,
};

// Backed by the MangaBaka database (search-first, permissive CORS). We fetch a
// broad manga search and rank it client-side by popularity to build the grid.
const MB_SEARCH = 'https://api.mangabaka.dev/v1/series/search';

function mbPopularity(it) {
  const p = it && it.popularity && it.popularity.global;
  return (p && typeof p.current === 'number' ? p.current : 0) || 0;
}
function mbCover(it) {
  const c = (it && it.cover) || {};
  return (c.x350 && c.x350.x1) || (c.x250 && c.x250.x1) || (c.raw && c.raw.url) || '';
}
function prettyGenre(g) {
  return String(g || '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function mbUsable(x) {
  return x && x.state !== 'merged' && mbCover(x) && String(x.title || '').trim().length >= 3;
}
function normalizeMB(it) {
  const title = it.title || it.romanized_title || it.native_title || 'Untitled';
  const cover = mbCover(it);
  return {
    id: it.id,
    title: { romaji: it.romanized_title || title, english: title },
    coverImage: { large: cover },
    averageScore: typeof it.rating === 'number' ? Math.round(it.rating) : null,
    genres: (Array.isArray(it.genres) ? it.genres : []).map(prettyGenre),
  };
}

// Bump on every render() so a slow fetch from a previous view can't overwrite
// the section element after the user has navigated away and back.
let renderToken = 0;

export function render(view, _params) {
  view.replaceChildren();

  const section = el('section', { class: 'suggest-section' });
  view.append(section);

  load(section);
}

async function load(section) {
  const token = ++renderToken;

  section.replaceChildren(
    sectionHeader('Popular now', icon('trending')),
    skeletonGrid(18),
  );

  let media;
  try {
    media = await fetchAnilistTrending();
  } catch (err) {
    if (token !== renderToken) return;
    section.replaceChildren(
      sectionHeader('Popular now', icon('trending')),
      errorBox(`Couldn't reach MangaBaka: ${err.message || err}`),
      el('div', { class: 'center', style: { marginTop: '14px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(section) }),
      ),
    );
    return;
  }

  if (token !== renderToken) return;

  if (!media.length) {
    section.replaceChildren(
      sectionHeader('Popular now', icon('trending')),
      emptyState('MangaBaka has nothing to show right now — check back soon.'),
      el('div', { class: 'center', style: { marginTop: '14px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(section) }),
      ),
    );
    return;
  }

  const grid = el('div', { class: 'grid' });
  for (const item of media) grid.appendChild(trendingCard(item));
  section.replaceChildren(
    sectionHeader('Popular now', icon('trending')),
    grid,
  );
}

// Broad MangaBaka search ranked client-side by popularity → a "popular" grid.
async function fetchAnilistTrending() {
  const p = new URLSearchParams({ q: 'a', type: 'manga', content_rating: 'safe', limit: '30' });
  const res = await fetch(`${MB_SEARCH}?${p.toString()}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const items = (Array.isArray(json && json.data) ? json.data : []).filter(mbUsable);
  items.sort((a, b) => mbPopularity(b) - mbPopularity(a));
  return items.slice(0, 24).map(normalizeMB);
}

function anilistTitle(item) {
  const t = item && item.title;
  return (t && (t.english || t.romaji)) || 'Untitled';
}

// Premium cover card: lazy proxied cover, score + lead-genre chips floated over
// the artwork, title below. Tapping runs a global search for the title.
function trendingCard(item) {
  const title = anilistTitle(item);
  const cover = (item.coverImage && item.coverImage.large) || '';
  const score = typeof item.averageScore === 'number' ? item.averageScore : null;
  const genre = Array.isArray(item.genres) && item.genres.length ? item.genres[0] : null;

  const coverWrap = el('div', { class: 'cover' });
  // AniList's CDN serves images with permissive CORS — load them DIRECTLY, not
  // through the Nyora image proxy (which is for hotlink-protected source CDNs).
  const src = cover;
  if (src) {
    const img = el('img', {
      loading: 'lazy',
      decoding: 'async',
      alt: title,
      src,
    });
    img.addEventListener('error', () => { img.style.display = 'none'; });
    coverWrap.appendChild(img);
  }

  // Score / genre micro-tags over the cover, echoing the desktop caption row.
  const tags = [];
  if (score != null) tags.push(chip(`${score}%`, { class: 'status-completed' }));
  if (genre) tags.push(chip(genre));
  if (!tags.length) tags.push(chip('Trending'));
  coverWrap.appendChild(
    el('div', {
      class: 'chips',
      style: { position: 'absolute', left: '8px', right: '8px', bottom: '8px', gap: '6px' },
    }, ...tags),
  );

  const node = el(
    'div',
    { class: 'card', role: 'button', tabindex: '0' },
    coverWrap,
    el('div', { class: 'title', title }, title),
  );
  const go = () => router.navigate('search', { q: title });
  node.addEventListener('click', go);
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
  });
  return node;
}

function skeletonGrid(n) {
  const grid = el('div', { class: 'grid' });
  for (let i = 0; i < n; i++) grid.appendChild(skeletonCard());
  return grid;
}
