# FebBox HLS Pool — multi-account fetcher with usage guard

Paste in many FebBox account cookies → the app validates each one, rotates
through them (least-used first) to fetch HLS master playlists for any `fid`,
marks dead/non-VIP accounts **inactive**, parks accounts that cross the
**100 GB usage guard**, and gives you one-click **reset** endpoints for when
you renew a plan.

**Usage is REAL, not estimated** — the pool mirrors each account's actual
"High Speed Flow" counter straight from FebBox
(`/console/user_traffic_query`), so the 100 GB guard works on the same number
FebBox uses, including its **daily reset**: parked accounts come back to
active automatically once FebBox reports the flow as reset.

Built as a single Next.js app. **No ORM, no Prisma, no Docker Compose** —
the database is plain MariaDB/MySQL you manage with phpMyAdmin, using the
raw SQL in [`schema.sql`](schema.sql), and the app talks to it with direct
parameterized SQL (`mysql2`).

---

## Features

- **Cookie pool** — add one cookie per line; each is validated against FebBox
  (email, plan, VIP state extracted and stored). Not-VIP or rejected cookies
  are saved but marked `inactive` and never used for fetching.
- **Real usage tracking** — usage mode `real` (default) reads each account's
  actual high-speed flow usage from FebBox after every fetch and via the
  **Sync real usage** button / `POST /api/usage/sync`. If FebBox can't be
  reached, the size-based estimate is applied as a temporary fallback so the
  guard still protects the account. Legacy size-estimate mode is still
  available in Settings.
- **Auto park / auto unpark** — an account crossing the configured limit is
  parked `limit_reached`; when FebBox's daily flow reset brings the real
  number back under the limit, the next sync reactivates it — no manual
  resets needed for daily-plan renewals.
- **Rotation fetch** — `POST /api/fetch` walks the pool: active + VIP +
  under-limit accounts only, least-used then least-recently-used first.
  Returns the master (AUTO) m3u8 URL plus all pre-signed quality URLs.
- **Account protection** — every successful fetch adds the estimated file
  size to the account's usage counter; at `USAGE_LIMIT_GB` (default 100) the
  account is parked as `limit_reached` until you reset it.
- **Reset endpoints** — reactivate everything after a plan renewal with one
  call (optionally clearing usage), or per-cookie.
- **Webshare rotating proxy** — all FebBox traffic goes through the proxy
  with automatic direct-connection fallback.
- **Dashboard UI** — stats, fetch panel with quality picker, pool table with
  usage bars and per-cookie management, live logs, settings dialog.

## Architecture

```
Browser ── Next.js dashboard (UI)
              │
              ▼
        Next.js API routes (node runtime)
              │                    │
              │                    └── MariaDB / MySQL  (direct SQL, mysql2)
              │                          cookie_accounts / fetch_logs / settings
              ▼
        FebBox web API  ── via Webshare rotating proxy (undici ProxyAgent)
        /file/player → var sources = [...] → hls.shegu.net master playlist
```

- `schema.sql` — the whole database, 3 tables, paste into phpMyAdmin (only
  needed for a brand-new database; existing installs upgrade automatically
  at startup — new columns are added by the app itself)
- `src/lib/db.ts` — `DATABASE_URL` parser (handles `@` in passwords, `ssl`
  and `sslaccept=accept_invalid_certs` params) + mysql2 pool, UTC everywhere
- `src/lib/pool.ts` — all SQL: settings, cookie CRUD, rotation candidates,
  usage accounting, logs
- `src/lib/febbox.ts` — FebBox endpoints, cookie/JWT parsing, proxy HTTP
- `src/app/api/**` — REST endpoints
- `nixpacks.toml` — Nixpacks build plan (Coolify / Railway / CLI)

---

## Requirements

| Thing     | Version                                      |
|-----------|----------------------------------------------|
| Node.js   | 20 or newer                                  |
| MariaDB   | 10.4+ (or MySQL 8+) — your VPS has this      |
| phpMyAdmin| any — only needed once to run `schema.sql`   |
| npm       | ships with Node                              |

## Deploy on the VPS (step by step)

### 1. Get the code on the VPS

```bash
# unzip the project (or git clone) into e.g. /opt/febbox-pool
cd /opt/febbox-pool
```

### 2. Create the tables — phpMyAdmin

1. Open phpMyAdmin and select the **`febusage`** database in the sidebar.
2. Click the **SQL** tab.
3. Open `schema.sql`, copy **the whole file**, paste it, press **Go**.
4. You should see `cookie_accounts`, `fetch_logs`, `settings` appear.

`schema.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`) — re-running it
never deletes data. phpMyAdmin is not needed again after this.

### 3. Configure the environment

```bash
cp .env.example .env
nano .env
```

```ini
# your MariaDB — a literal "@" in the password is fine (the parser splits
# at the last "@"), but %40 is cleaner:
DATABASE_URL=mysql://root:Mariadb24%40@vvdg0b6qpjl63373qo3vpk8h:3306/febusage?ssl=true&sslaccept=accept_invalid_certs

DEFAULT_PROXY_URL=http://<webshare-user>:<webshare-pass>@p.webshare.io:80
DEFAULT_PROXY_ENABLED=true
USAGE_LIMIT_GB=100
AUTO_USAGE=true
# optional: pre-load one account on first start (only when pool is empty)
# FEBBOX_SEED_COOKIE=ci=...; PHPSESSID=...; ui=...
# optional: password-protect the dashboard
# APP_PASSWORD=pick-a-password
PORT=3000
```

> These are read once at startup as *defaults*; anything you change later in
> the web UI (Settings dialog) is stored in the `settings` table and wins.

### 4. Build and run

```bash
npm install
npm run build
npm start          # serves on 0.0.0.0:$PORT (default 3000)
```

Open `http://<vps-ip>:3000`.

### 5. Keep it running

**pm2 (easiest):**

```bash
npm i -g pm2
pm2 start npm --name febbox-pool -- start
pm2 save && pm2 startup
```

**or systemd** — `/etc/systemd/system/febbox-pool.service`:

```ini
[Unit]
After=network.target mariadb.service
[Service]
WorkingDirectory=/opt/febbox-pool
ExecStart=/usr/bin/npm start
Restart=always
EnvironmentFile=/opt/febbox-pool/.env
[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now febbox-pool
```

## Deploy with Nixpacks (no Docker Compose)

The repo ships `nixpacks.toml` — a plain build plan, one app, no compose
stack.

**Coolify:** create a resource → *Deploy from source* pointing at this
folder. Nixpacks is auto-detected; set the env vars from step 3 in the UI;
port comes from `$PORT`.

**CLI on the VPS itself:**

```bash
npm i -g @railway/nixpacks
nixpacks build . --name febbox-pool --run   # builds and runs the image
```

Build = `npm install && npm run build`, start = `npm start`
(`node .next/standalone/server.js` — plain Node, binds `0.0.0.0:$PORT`).

---

## Environment variables

| Var                    | Required | Meaning                                                        |
|------------------------|----------|----------------------------------------------------------------|
| `DATABASE_URL`         | yes      | `mysql://user:pass@host:3306/db` — `?ssl=true&sslaccept=accept_invalid_certs` supported; `@` in passwords may be written literally or as `%40` |
| `DEFAULT_PROXY_URL`    | no       | Webshare rotating proxy (or any HTTP proxy)                    |
| `DEFAULT_PROXY_ENABLED`| no       | `true`/`false`, default `true`                                 |
| `USAGE_LIMIT_GB`       | no       | per-account park threshold, default `100`                      |
| `AUTO_USAGE`           | no       | add estimated GB to usage after each fetch, default `true`     |
| `USAGE_MODE`           | no       | `real` (default) — track FebBox's own flow counter; or `estimate` |
| `AUTO_SYNC_USAGE`      | no       | re-sync real usage right after each fetch, default `true`      |
| `FEBBOX_BASE`          | no       | override FebBox API base URL (advanced/testing)                |
| `FEBBOX_SEED_COOKIE`   | no       | one cookie string, seeded on first start if the pool is empty  |
| `APP_PASSWORD`         | rec.     | if set, dashboard + API require it (`x-app-password` header)   |
| `PORT`                 | no       | default `3000`                                                 |

## API reference

All endpoints accept/return JSON. If `APP_PASSWORD` is set, send it as
`x-app-password: <password>` (or `Authorization: Bearer <password>`).

| Method & path                        | Purpose |
|--------------------------------------|---------|
| `GET  /api/health`                   | `{ ok, authRequired }` |
| `GET  /api/cookies`                  | list pool + current settings |
| `POST /api/cookies`                  | `{ cookies: "one per line", label? }` → validates each via proxy, dedupes by uid |
| `DELETE /api/cookies/:id`            | remove one |
| `PATCH /api/cookies/:id`             | re-validate now (checks VIP/plan again) |
| `POST /api/cookies/:id/reset`        | reactivate; `?clearUsage=1` zeroes usage |
| `POST /api/cookies/:id/usage`        | `{ gb: ±number }` manual usage adjust |
| `POST /api/cookies/reset-all`        | `{ clearUsage?: bool }` reactivate all inactive/limit_reached |
| `POST /api/fetch`                    | `{ fid, shareKey?, quality? }` → rotation fetch |
| `POST /api/usage/sync`               | `{ id? }` — pull REAL flow usage from FebBox; omit `id` to sync the whole pool. Park/unpark applied. |
| `GET  /api/usage/sync`               | same as POST without a body (cron-friendly) |
| `GET  /api/logs`                     | last 60 fetch log rows |
| `GET/PUT /api/settings`              | read / update proxy + limits |

`POST /api/fetch` responses:

- `200 { success: true, masterUrl, sources[], qualities[], usedCookie, usage{mode, synced, realUsedGb, realLimitGb, realResetAt}, estGbAdded, proxyUsed }`
  — `usage.mode` is `real` when the account's flow counter was mirrored from
  FebBox (`synced: true`) or `estimate` when the size-based fallback applied.
- `409 { error: "no_active_cookies" }` — pool empty or nothing eligible
- `502 { error: "all_failed", attempts[] }` — every candidate failed

curl examples:

```bash
curl -X POST http://127.0.0.1:3000/api/fetch \
  -H 'content-type: application/json' \
  -d '{"fid":"31264714","quality":"AUTO"}'

curl -X POST http://127.0.0.1:3000/api/cookies/reset-all \
  -H 'content-type: application/json' -d '{"clearUsage":true}'
```

## How the rotation protects your accounts

1. Candidates = `status='active' AND is_vip=1 AND usage_gb < USAGE_LIMIT_GB`
2. Order: least `usage_gb`, then least-recently-used — spreads load evenly
3. FebBox call goes through the rotating proxy; on network failure it
   retries once directly
4. **Account-level rejection** (not VIP / expired / login / banned) →
   cookie marked `inactive`, next candidate takes over
5. **Transient error** → logged, next candidate, cookie stays active
6. Success → in **real mode** the account's `usage_gb` is set to the value
   FebBox just reported (its daily flow counter); if that fetch failed to
   read FebBox, the estimated size of the requested quality is added as a
   fallback — crossing the limit parks the account as `limit_reached`
7. **Daily reset, handled** — when FebBox reports the flow as reset (used
   back under the limit), the next sync (button, cron ping, or next fetch)
   flips the account back to `active` automatically
8. Bought/renewed plans? → `POST /api/cookies/reset-all` (optionally
   `{"clearUsage":true}`) and everything is back in rotation

## Security notes

- The pool stores live FebBox session cookies in your MariaDB — keep the
  VPS patched and set `APP_PASSWORD` if port 3000 is publicly reachable.
- Prefer binding the app to localhost and fronting it with nginx/Caddy +
  TLS; `APP_PASSWORD` still protects the API in that setup.
- The MariaDB root account in `DATABASE_URL` stays on the VPS — never
  commit `.env`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Access denied for user 'root'` | wrong password in `DATABASE_URL`, or root only allows unix-socket auth — create an app user: `CREATE USER 'febbox'@'localhost' IDENTIFIED BY 'pw'; GRANT ALL ON febusage.* TO 'febbox'@'localhost';` |
| SSL handshake errors | self-signed cert on the VPS → keep `?sslaccept=accept_invalid_certs` in the URL |
| `ER_NO_SUCH_TABLE` | `schema.sql` not imported — do the phpMyAdmin step |
| `no_active_cookies` | all cookies inactive/limit_reached → reset-all, or add fresh cookies |
| Timestamps look shifted | all DB times are UTC; the UI renders them in your browser's timezone |
| Old SQLite data from the previous build | not migrated — re-paste your cookies once; they validate and refill the pool |

## Where the real usage comes from

```
GET /console/user_traffic_query  →  { code:1, data:{
      used: <number, GB>,          ← the account's real used high-speed flow
      traffic_usage: "42 GB / 100 GB",
      traffic_limit: "100 GB",
      reset_at: "12 Hours"         ← when FebBox resets the counter
} }
```

This is the same endpoint the FebBox web console uses for its
"High Speed Flow / Usage / Flow Reset" popup (10 GB/day free,
100 GB/day Premium). The app stores the last synced value
(`real_usage_gb`, `usage_synced_at`, source badge REAL / EST / MANUAL in the
pool table) and never mixes it with the estimate.

## FebBox fetch chain (what the app automates)

```
GET /share/{key}                 → data-id = fid
POST /file/player {fid,share}    → HTML with var sources = [ ORG/AUTO/1080p/... ]  (pre-signed, ~4-5 h)
GET /console/video_quality_list  → per-quality sizes → usage estimates
hls.shegu.net/*.m3u8             → master playlist (AUTO) or per-quality playlist
hls-aws.shegu.net segments       → fMP4, CloudFront-signed
```

Signatures are bound to the exact query string (tampering → 403) but **not**
to an IP, so any machine/proxy can play the returned URLs until they expire.
