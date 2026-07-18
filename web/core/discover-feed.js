// core/discover-feed.js — the AniList Discover query, shared by the browser
// (screens/discover.js) and the deploy-time prerenderer
// (scripts/prerender-discover.mjs).
//
// It lives here so the two can't drift: the prerendered snapshot on the cluster
// must have exactly the shape the client renders, or a deploy would ship a feed
// the UI silently drops. Pure data + fetch, no DOM — importable from Node.

export const ANILIST_API = 'https://graphql.anilist.co';

export const MEDIA_FIELDS = 'id title { romaji english native } '
  + 'coverImage { large extraLarge } bannerImage genres averageScore countryOfOrigin';

// The rail keys, in the order load() paints them.
export const FEED_KEYS = ['trending', 'manhwa', 'manhua', 'manga', 'action', 'romance', 'fantasy'];

export const EMPTY_FEED = Object.fromEntries(FEED_KEYS.map((k) => [k, []]));

// Renderers need a real cover, so entries without one are dropped at the source.
export function mediaUsable(m) {
  return !!(m && m.coverImage && (m.coverImage.extraLarge || m.coverImage.large));
}

export function feedNonEmpty(f) {
  return !!(f && Array.isArray(f.trending) && f.trending.length);
}

export function discoverQuery() {
  const page = (alias, filter, sort) =>
    `${alias}: Page(perPage: 30) { media(type: MANGA, isAdult: false, ${filter}sort: ${sort}) { ${MEDIA_FIELDS} } }`;
  return `query {
    ${page('trending', '', 'TRENDING_DESC')}
    ${page('manhwa', 'countryOfOrigin: KR, ', 'POPULARITY_DESC')}
    ${page('manhua', 'countryOfOrigin: CN, ', 'POPULARITY_DESC')}
    ${page('manga', 'countryOfOrigin: JP, ', 'POPULARITY_DESC')}
    ${page('action', 'genre: "Action", ', 'TRENDING_DESC')}
    ${page('romance', 'genre: "Romance", ', 'TRENDING_DESC')}
    ${page('fantasy', 'genre: "Fantasy", ', 'TRENDING_DESC')}
  }`;
}

export async function fetchFromAniList() {
  const res = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: discoverQuery() }),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  const d = (json && json.data) || {};
  const pick = (k) => (((d[k] && d[k].media) || []).filter(mediaUsable));
  return Object.fromEntries(FEED_KEYS.map((k) => [k, pick(k)]));
}
