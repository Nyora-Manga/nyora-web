# Live Presence Counter + Manga Comments — Design

**Date:** 2026-08-05
**Status:** Approved
**Repos touched:** `nyora-web`, `nyora-sync-server`

## Goal

Increase engagement on Nyora Web with two features:

1. A **site-wide live active-user counter** ("N reading now") visible to everyone.
2. **Comments for signed-in users**, one thread per manga, on the details page.

Both must respect the project's "No ads, ever. No tracking, ever." promise and
must never block or degrade reading if the sync server is unreachable.

## Decisions (from brainstorming)

- Presence granularity: **site-wide only** (no per-manga / per-chapter counts).
- Comments scope: **manga details page only** (no per-chapter threads).
- Moderation: **report button + admin delete** (plus rate limits, length caps,
  author-delete-own). No word filter at launch.
- Identity: **chosen unique username**, set once before first comment. No email
  leakage, no auto-generated names.
- Architecture: **extend the existing FastAPI sync server** (`sync.nyora.xyz`)
  with a `social` router. No new service, DB engine, domain, or deploy.
- Liveness: **polling**, not WebSockets. 60 s heartbeat + 60 s count refresh.

## Architecture

```
nyora-web (static PWA)
  web/core/social.js      ← new: presence heartbeat + comments client
  web/app.js / header     ← live-count pill
  web/screens/details.js  ← comments section
        │  HTTPS (existing CORS config)
        ▼
nyora-sync-server (FastAPI, sync.nyora.xyz)
  app/social.py           ← new router: /presence/*, /comments/*
  app/auth.py             ← + POST /auth/username, username/is_admin in token flow
  app/models.py           ← + users.username/is_admin, comments, comment_reports
```

Presence state is an in-memory dict in the FastAPI process. Comments persist in
the existing SQLite DB via SQLAlchemy, created by the existing
`Base.metadata.create_all` lifespan hook (new columns on `users` need a small
one-off migration; new tables are auto-created).

## Backend API

### Presence — no auth, no persistence

- `POST /presence/ping` — body `{"sid": "<uuid>"}`. `sid` is a random UUID the
  client generates per browser session (sessionStorage). Server stores
  `sid → last_seen` in RAM only. No IP, UA, or account linkage is stored.
  Rate-limited via existing `app/ratelimit.py`.
- `GET /presence/count` → `{"count": <int>}` — unique sids seen within the last
  **120 s**; stale entries pruned on read. Response cacheable ~30 s.

### Comments — JWT auth via existing dependency

- `GET /comments/{nyora_id}?before=<ISO ts>&limit=50` — public read, newest
  first, cursor-paginated. Soft-deleted rows returned as
  `{deleted: true}` placeholders to keep threads coherent.
- `POST /comments/{nyora_id}` — body `{"body": "<1–2000 chars>"}`. Requires the
  user to have a username; otherwise `409 username_required`. Rate limits:
  5/min and 60/day per user.
- `DELETE /comments/{id}` — author or admin (soft delete: sets `deleted_at`).
- `POST /comments/{id}/report` — optional `{"reason"}`; unique per
  (comment, user).
- `GET /comments/reported` — admin only: reported, not-yet-deleted comments
  with report counts.
- `POST /auth/username` — set/change handle. 3–24 chars, `[a-z0-9_]`,
  case-insensitively unique. Username (and `is_admin`) surfaced to the client
  alongside the existing auth/me flow.

Errors follow the existing `{"detail": "<message>"}` convention.

## Data model

```
users            + username   TEXT UNIQUE NULL
                 + is_admin   BOOLEAN NOT NULL DEFAULT 0

comments         id INTEGER PK
                 nyora_id     TEXT NOT NULL (indexed)
                 user_id      FK → users
                 body         TEXT NOT NULL
                 created_at   DATETIME (UTC)
                 deleted_at   DATETIME NULL   -- soft delete

comment_reports  id INTEGER PK
                 comment_id   FK → comments
                 user_id      FK → users
                 reason       TEXT NULL
                 created_at   DATETIME (UTC)
                 UNIQUE(comment_id, user_id)
```

`nyora_id` is the cross-platform stable manga hash already used by sync, so a
thread attaches to the same manga on every source and device. Admin flag is set
manually in the DB (no admin-management UI).

## Frontend

### Live-count pill

- Material chip in the app top bar and on Discover: pulsing green dot +
  "312 reading now".
- `web/core/social.js` pings `/presence/ping` every 60 s while the tab is
  visible (`visibilitychange` pauses/resumes; ping immediately on resume) and
  refreshes `/presence/count` every 60 s.
- **Floor:** the pill is hidden when count < 3, so a quiet site never
  advertises emptiness.
- Fails silent: any network/server error hides the pill; reading is never
  affected.

### Comments on the details page

- Collapsed "Comments (N)" section beneath the chapter list in
  `screens/details.js`.
- Signed-out: comments are readable + "Sign in to join the discussion" CTA
  deep-linking to the existing auth flow (comments double as a sign-up driver).
- First post with no username: inline "pick a username" prompt calling
  `POST /auth/username`, then the comment posts.
- Each comment: username, relative timestamp, plain-text body (escaped,
  newlines preserved — no markdown/HTML). Overflow menu: Delete (own or
  admin), Report.
- Optimistic posting; "Load more" pagination (50/page).
- Admin accounts additionally see a "Reported" filter backed by
  `GET /comments/reported`.

## Privacy posture

- Presence is aggregate-only and ephemeral: random session id, RAM only, never
  written to disk, never linked to accounts, no IP/UA retained. README gains
  one honest sentence describing the anonymous live counter.
- Comments are explicit user-published content, not tracking.

## Testing

- **Server (pytest):** presence window pruning and uniqueness; username
  validation/uniqueness; comment CRUD auth matrix (anonymous / author / other
  user / admin); soft-delete placeholder behaviour; report dedupe; rate limits.
- **Web (manual):** phone + desktop, signed-in and signed-out; pill floor
  behaviour; graceful degradation with the sync server down; username prompt
  flow; report/delete flows; admin reported view.

## Out of scope

- Per-manga or per-chapter presence counts.
- Per-chapter comment threads, replies/nesting, votes, editing, markdown.
- Word filters / auto-moderation; admin management UI.
- WebSockets or server-sent events for live updates.
