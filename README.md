# Nyora Web

A **100% client-side** browser build of the **Nyora** manga reader. There is no
backend: catalog/search/details/page parsing all runs **in the browser**, and
the app deploys as plain static files.

## Features

- **Read in any browser** — no install; works on desktop and mobile browsers, installable as a PWA with an offline app shell (service worker).
- **Huge source catalogue** — browse, search and filter hundreds of online manga/manhwa/manhua sources, parsed entirely client-side (parser bundles loaded over-the-air, SHA-256 verified, with bundled fallbacks).
- **Standard & Webtoon reader** — paged (LTR/RTL) and vertical webtoon modes with per-title settings.
- **Library that stays organized** — favourites in custom categories and reading history.
- **AniList tracking** — connect AniList (talks to its GraphQL API directly from the browser) to keep progress in sync.
- **Cloud sync** — sign in with Google; your library **and source preferences** (installed/pinned) sync per-row across devices via Supabase (last-write-wins).
- **Self-hostable** — deploys as static files to any host; the only server-side piece is a tiny Cloudflare Worker that proxies CORS/images.

## Architecture

```
nyora-web/
├── web/                 ← the SPA (this is what gets deployed)
│   ├── index.html, app.js, styles.css, sw.js
│   ├── core/            ← api, parser-runtime, sync, ui, library, store
│   └── core/web-parsers/← bundled parser fallbacks + sources.json
├── cloudflare-worker/   ← the CORS / image proxy worker (worker.js + wrangler.toml)
└── netlify.toml         ← static publish config (publish = "web")
```

- **Parsing runs in-browser.** `core/parser-runtime.js` loads JS parser bundles
  over-the-air (`hasan72341.github.io/nyora-ota-parsers`, SHA-256 verified, with
  the bundled `core/web-parsers/` as fallback) and executes them client-side.
- **CORS bypass = the Cloudflare worker.** Manga sites don't send
  `Access-Control-Allow-Origin`, so the parser fetches HTML through the worker
  (`<proxy>/proxy?url=…`) and loads cover/page images through it
  (`<proxy>/image?u=…&h=Referer:…`), which adds the source `Referer`/`UA`.
  Many CDNs serve covers/pages directly to an `<img>`, so the app tries direct
  first and only falls back to the worker. The worker is the **only** server-side
  piece, and it does nothing but proxy.
- **AniList tracker is direct.** AniList's GraphQL API is CORS-enabled (it
  allows the `Authorization` header), so `core/api.js` talks to
  `https://graphql.anilist.co` straight from the browser — no proxy.
- **Account sync is client-side.** `core/sync.js` uses Google Identity Services
  for an ID token, exchanges it with Supabase Auth, and reads/writes through the
  `nyora-sync` Supabase edge function. Library **and source prefs** (installed/
  pinned) sync per-row with last-write-wins.

## Run locally

It's static — serve the `web/` folder with anything:

```bash
cd web
python3 -m http.server 3000
# → open http://127.0.0.1:3000
```

Use **`http://127.0.0.1:3000`** specifically: it's the JavaScript origin
authorized in the Google OAuth client, so Google sign-in works there. Other
origins fail with `Error 400: origin_mismatch` — add them in Google Cloud first.

The parser worker URL can be overridden at runtime via the
`nyora.webParser.proxyUrl` localStorage key (defaults to the bundled worker).

## The Cloudflare worker

```bash
cd cloudflare-worker
npx wrangler@latest login      # first time
npx wrangler@latest deploy     # publishes nyora-cors-proxy
```

See `cloudflare-worker/worker.js` — it serves `/proxy?url=` (HTML) and
`/image?u=…&h=Name:Value` (images, applying the source-site Referer/UA).

## Deploy

Static hosting. On Netlify the included `netlify.toml` publishes `web/`; the
SPA fallback lives in `web/_redirects`. Any static host works (Netlify, Pages,
S3+CDN, …) — just serve `web/` and register the deployed origin in Google Cloud
for sign-in.
