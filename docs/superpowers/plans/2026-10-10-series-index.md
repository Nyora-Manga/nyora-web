# Series dictionary implementation plan

Goal: publish useful public manga pages with TF-IDF search and crawlable links.
Architecture: a fixed metadata snapshot feeds a pure TF-IDF module and static renderer; scheduled refresh feeds the existing two-node deployment.
Tech: Node.js, existing esbuild and Playwright, AniList GraphQL, Caddy static files.

1. Add scripts/series/metadata.mjs for normalization, immutable slugs and safe covers; scripts/refresh-series.mjs for atomic all-or-nothing fixed-ID refresh. Snapshot in data/series.json; covers in data/series-covers. Verify adult filtering, HTML stripping, stable routes and dates.
2. Add web/core/series-index.js with buildIndex, searchIndex and relatedSeries. Verify alias/native title retrieval, field weighting, unknown query handling, finite scores and deterministic related results.
3. Add scripts/series/render.mjs and scripts/build-series.mjs: initial HTML, canonical metadata, local covers, catalogue dictionary, related links and sitemap. Add external catalogue JS/CSS and bundle its entry after the existing app build. Verify escaping and sitemap URL/page correspondence.
4. Link the catalogue from initial root HTML and runtime Discover. Update robots/llms guidance. Add schedule/refresh and catalogue browser checks to deploy.yml. Preserve the existing CSP and security tests.
5. Run npm tests, security tests, build, desktop and catalogue browser tests. Inspect desktop/mobile screenshots; push main/deploy; wait for both deployments and verify live HTML, cover, sitemap, API gate and app handoff. Record Search Console submission status honestly.
