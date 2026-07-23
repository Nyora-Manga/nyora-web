// scripts/prerender-discover.mjs — bake the Discover feed into dist/ at deploy
// time, so it ships to the cluster as a static file.
//
// Why not real SSR: the three nodes serve the app as static files through Caddy
// with no application runtime, so there is nothing to render on per request.
// Prerendering gets the same user-visible result — Discover is identical for
// every visitor, so it does not need to be per-request — while keeping the
// nodes static.
//
// What this buys: a FIRST-EVER visitor previously waited on a cross-origin
// AniList round trip before seeing anything. Now the feed arrives from the same
// origin as the app (already-warm connection, no extra DNS/TLS) and paints
// immediately. It also means AniList is not hit once per new user, so the
// ~30 req/min public cap stops being a scaling limit.
//
// Freshness: the snapshot is a floor, not a ceiling. The client still
// revalidates against AniList in the background once the copy it holds is past
// FEED_TTL, so content stays current between deploys.
//
// A failure here is NON-FATAL: the client falls back to fetching AniList
// directly, exactly as it did before. A deploy must not break because a
// third-party API had a bad minute.
import { writeFile, mkdir } from 'node:fs/promises';
import { fetchFromAniList, feedNonEmpty, FEED_KEYS } from '../web/core/discover-feed.js';

const OUT = 'dist/discover-feed.json';

try {
  const feed = await fetchFromAniList();
  if (!feedNonEmpty(feed)) throw new Error('AniList returned an empty trending list');

  // Trim to what the rails actually show. The full 30-per-rail response is
  // ~7x larger than the UI uses, and this file is on the first-paint path.
  const trimmed = Object.fromEntries(FEED_KEYS.map((k) => [k, (feed[k] || []).slice(0, 20)]));

  await mkdir('dist', { recursive: true });
  const body = JSON.stringify({ at: Date.now(), feed: trimmed });
  await writeFile(OUT, body);

  const counts = FEED_KEYS.map((k) => `${k}=${trimmed[k].length}`).join(' ');
  console.log(`✓ prerendered ${OUT} (${(body.length / 1024).toFixed(0)} KB) ${counts}`);
} catch (err) {
  // Deliberately exit 0 — see the note above.
  console.warn(`⚠ discover prerender skipped: ${err.message}`);
  console.warn('  Deploy continues; clients will fetch AniList directly as before.');
}
