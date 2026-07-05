# Nyora Web — Docker

Run the Nyora web app **locally**: the SPA, the parser **helper**, and
**FlareSolverr** all run on your machine. The **only** remote dependency is the
**sync backend** (account/library sync), which stays at
`https://stream.hasanraza.tech` by default.

```
┌──────────────────────── nyora-web container ─────────────────────────┐
│  Caddy  :8080                                                         │
│    ├─ /*        → static SPA  (/srv, built by esbuild)               │
│    └─ /api/*    → strip /api → parser helper 127.0.0.1:8788 (Java)   │
│                                     │                                 │
└─────────────────────────────────────┼─────────────────────────────────┘
                                       │ compose network
                              ┌────────▼─────────┐
                              │ flaresolverr :8191│  (Cloudflare solver)
                              └───────────────────┘

   remote (NOT in Docker):  sync → https://stream.hasanraza.tech
```

Because the helper is served **same-origin** under `/api`, there are no CORS
issues — the browser only ever talks to the one origin it loaded from.

## One command

```bash
docker compose up --build
```

Then open **http://localhost:8080**.

First build is slow (minutes): it clones `nyora-linux` + the `nyora-shared`
submodule and does a cold Gradle build (downloads Gradle 9.3.1 + deps, incl. the
jitpack parser engine). Rebuilds are fast thanks to a BuildKit Gradle cache
mount. FlareSolverr is `linux/amd64`; on Apple Silicon it runs under emulation
(slower start, works fine).

## Ports

| Port | Service | Notes |
|------|---------|-------|
| `8080` | Caddy / SPA / `/api` helper | host-published (override with `WEB_PORT`) |
| `8788` | parser helper | container-internal (loopback only) |
| `8191` | FlareSolverr | container-internal (not published) |

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `NYORA_SYNC_URL` | `https://stream.hasanraza.tech` | Remote sync backend. Point at your own to self-host sync. |
| `WEB_PORT` | `8080` | Host port for the web app. |
| `NYORA_ENGINE_REF` | `main` | `nyora-linux` git ref the helper jar is built from (build-time). |

Examples:

```bash
# Serve on a different host port
WEB_PORT=9000 docker compose up --build

# Point sync at a different backend
NYORA_SYNC_URL=https://sync.example.com docker compose up --build

# Build the helper from a specific ref
NYORA_ENGINE_REF=v2.0.0 docker compose build
```

`env.js` is (re)generated at container start from these vars, so changing
`NYORA_SYNC_URL` takes effect on `up` with **no rebuild**. `NYORA_HELPER_URL` is
computed in the browser as `location.origin + '/api'`, so it is always
same-origin regardless of how you reach the container (localhost, LAN IP, or an
outer HTTPS proxy).

> If you reconfigure a **running** deployment that a browser already visited as a
> PWA, hard-reload once — the service worker may serve the previously cached
> `env.js` on the first paint before revalidating.

## Data persistence

The helper's SQLite DB + port file live in the named volume **`nyora-data`**
(mounted at `/data`). It survives `docker compose down`. To wipe it:

```bash
docker compose down -v
```

## How it works

- **Multi-stage build** — a JDK stage builds the helper fat jar
  (`:shared:helperJar`), a Node stage builds the SPA (`npm ci && npm run build`),
  and a lean `eclipse-temurin:17-jre` + Caddy runtime stage ships only the jar +
  `dist/`. Runs as a **non-root** user.
- **JVM flags** mirror the production VM:
  `-Xmx320m -Xss512k -XX:MaxMetaspaceSize=128m -XX:ReservedCodeCacheSize=64m -XX:+UseSerialGC`.
- **Healthchecks** on both services. `nyora-web` only waits for FlareSolverr to
  *start* (not become healthy) — most sources need no Cloudflare solve and the
  helper degrades gracefully if the solver is down, so the app is never held
  hostage to the (emulated, slow-to-warm) browser. `nyora-web`'s own healthcheck
  hits `/api/health`, proving both the proxy and the helper are alive.
- **No secrets** are baked into the image; all config is runtime env.

## Troubleshooting

```bash
docker compose logs -f nyora-web        # entrypoint + helper + caddy logs
docker compose logs -f flaresolverr     # solver logs
curl http://localhost:8080/api/health   # {"status":"ok"} when healthy
curl http://localhost:8080/api/sources  # parser catalog through the proxy
```

- Web loads but Cloudflare-protected sources are empty → check FlareSolverr is
  healthy (`docker compose ps`); on Apple Silicon (qemu emulation) give it up to
  ~90s to warm up. Non-protected sources work without it.
- 404s on `/api/...` → the helper hasn't come up; check `nyora-web` logs for
  `helper healthy` vs a startup failure.
