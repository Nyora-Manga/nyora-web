# Public manga catalogue

The public collection lives at https://web.nyora.xyz/manga/. Each series has one stable, prerendered URL keyed by AniList ID, e.g. `/manga/solo-leveling-105398/`. The existing reader and source search keep their hash routes. This catalogue is separate from the protected **source** catalogue API: no parser configuration, user data, authentication material or chapter content is published here.

## Dictionary and pages

`data/series.json` seeds 40 explicit series IDs. Metadata is attributed to AniList on each page. Entries require an explicit `isAdult: false`, a substantial synopsis and an approved cover URL; Hentai entries are excluded. This is an adult-content exclusion based on provider metadata, not an all-ages certification. Covers are downloaded from AniList's allowed CDN paths, validated as JPEG/PNG/WebP and hosted under `/manga/covers/` with content-hashed filenames. No image proxy or arbitrary remote fetch endpoint is introduced.

`web/core/series-index.js` builds a weighted TF-IDF inverted dictionary. Term frequency uses `1 + log(count)`, with title/alias/genre/creator/synopsis field weights 6/4/2/2/1. IDF uses `1 + log((N+1)/(df+1))`; document and query vectors use L2 normalization. Exact title or alias matches receive a relevance boost. Unicode normalization and native-language bigrams support aliases without model downloads. Related links use cosine similarity among titles sharing at least one genre.

`npm run build` emits all series HTML, the fully linked catalogue, dictionary, page manifest, local covers and sitemap. Catalogue JS only enhances search: the entire collection and every synopsis remain usable without it. Search failure leaves the collection intact. Pages have unique metadata and canonicals and link into `/#/search?q=…` using the series title. The action searches a reader's selected sources; it does not promise chapter availability or invent a source match.

## Daily refresh and deployment

The existing two-node deployment workflow also runs daily at **03:23 UTC**. It first runs `npm run refresh:series -- --published` to compare with the last published snapshot and page manifest. CI reads the previous public files over the existing deployment SSH connection so a Cloudflare challenge does not invalidate the refresh. The checked-in ID allowlist bounds the refresh. Upstream errors or partial GraphQL responses fail the deployment, preserving the current site. The first deployment accepts a 404 for both public snapshot and manifest; subsequent published snapshots must include their manifest.

Content records keep their previous `lastmod` when unchanged. The final HTML is hashed too, so sitemap dates reflect visible page changes, including related links and template updates, without claiming every unchanged series was modified daily. `rsync --delete` removes titles that become adult or incomplete. Add new series IDs deliberately; refresh, review and commit the snapshot and referenced covers before shipping an expanded collection.

`ops/security/harden_caddy.py --enforce-catalog` now also preserves no-transform on public series documents, revalidates the dictionary/manifest/sitemap, and caches content-addressed covers. It still asserts that every existing CSP is byte-for-byte unchanged. Validate candidate Caddy files with the service environment loaded and back up the originals before reloading. No auth or API gate needs to be relaxed.

## Google discovery

`robots.txt` advertises `https://web.nyora.xyz/sitemap.xml`. The sitemap includes the root, catalogue and actual series pages only. Root HTML and the live Discover screen both link to the catalogue; every series has related links. Unknown URLs continue returning 404. No keyword stuffing or hash-search SearchAction is added.

For direct submission, a verified Search Console owner/full user can submit `https://web.nyora.xyz/sitemap.xml` under the domain property `sc-domain:nyora.xyz` or URL-prefix property `https://web.nyora.xyz/`, then inspect a sample series URL. There is no general web-page indexing API that forces these URLs into Google. Publication and sitemap submission are not proof of indexing or ranking.

Official references: [Google JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics), [sitemap submission](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap), [requesting recrawls](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl).

## Verification

- `npm test`: dictionary retrieval, aliases, score safety, metadata filtering/escaping, stable URLs/dates, sitemap completeness and failed-refresh preservation, alongside app regressions.
- `python3 -m unittest discover -s ops/security -v`: source catalogue and auth protections/Caddy patch.
- `npm run build && npm run test:catalogue`: real browser search, related links, covers, desktop/mobile, strict CSP, no-JS pages, 404s and unavailable-dictionary fallback.
- `npm run test:desktop`: existing app layout and behavior checks.
