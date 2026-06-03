# CLAUDE.md — orientation for future Claudes

You're working on the **Encyclopedia of AI Hallucinations (EAH)**: an OEIS-inspired, community-submitted, staff-reviewed catalog of LLM hallucinations. Read README.md for the user-facing story.

Co-founders: **Rudra Jadhav** and **Warren Woolf** (`warrenwoolf` on GitHub).

## Stack and conventions

- **Bun + TypeScript.** No build step. `bun run dev` (hot reload) or `bun src/server.ts`. Type-check with `bunx tsc --noEmit`.
- **Server-rendered HTML.** No client framework. Three static JS files: `src/static/theme.js` (dark-mode toggle), `src/static/browse.js` (browse filter progressive enhancement), and `src/static/turns.js` (multi-turn submit/edit form — mode toggle + add/remove turn; see "Multi-turn transcripts" below). Don't add more client JS without a real reason. **Static files are served from an explicit allowlist** (`STATIC_FILES` in `src/server.ts`) — adding a `/static/*` file requires updating that list AND the `deploy.sh` Cloudflare purge list.
- **MariaDB** via the `mariadb` driver. Everything goes through `src/db.ts` (`query`, `queryOne`, `execute`, `transaction`). Always use `?` parameters; never interpolate into SQL.
- **HTML rendering via `h\`...\``** in `src/html.ts`. ALL HTML output goes through `h\`\`` or `raw()`. `raw()` is for constants you fully control — never on user input.
- **CSRF:** HMAC-signed double-submit cookie + hidden field. Every form must include `<input type="hidden" name="_csrf" value="${csrfToken}">` and every mutating handler must call `verifyCsrf(req, form.get("_csrf"))`.
- **`parseForm()` only understands `application/x-www-form-urlencoded`.** Client-side `fetch` POSTs must send a `URLSearchParams` body, not `FormData` — otherwise `_csrf` arrives empty and the request silently 403s with no server log.
- **Rate-limiting:** in-memory token bucket per IP in `src/ratelimit.ts`. Buckets: `submit`, `login`, `signup`, `verify`, `oauth`, `withdraw`, `api`, `complaint`. Add a bucket for any new POST that writes to the DB on behalf of anonymous users.
- **Sessions:** cookie holds a random token; DB stores only its sha256. Logic in `src/auth.ts`.

## Security model — do not weaken

- **CSP:** strict. Don't relax to `'unsafe-inline'`.
- **No raw IPs stored.** `ip_hash` is `sha256(SESSION_SECRET || ip)`. `cf-connecting-ip` is honored only when the immediate TCP peer is loopback. Never trust `X-Forwarded-For`.
- **Input scrub:** all user text passes through `sanitizeText()` in `src/routes/types.ts` before storage (strips BiDi overrides, zero-width chars, C0/C1 controls).
- `multipleStatements: false` on the DB pool.

## The A-number system

`submissions.eah_number` (nullable INT) is displayed as `A######` (6-digit zero-padded). **A-numbers are allocated when a submission is first proposed for review** (the draft→pending-review transition), so EVERY non-draft row (pending review / pending acceptance / active / failed) carries one. Only drafts have `eah_number = NULL`. The number is the stable citable ID from the moment of submission; the trust tier (see "Submission & review flow") then governs whether the entry is publicly *listed*. Helpers in `src/eah-id.ts`:

- `allocateEahNumber(tx)` — pops MIN from `freed_eah_numbers` if any, else `MAX+1`. Called in the **propose** transition (`src/routes/my.ts` `myPropose`, and `src/routes/submit.ts` when submitting straight for review), inside the insert/update tx. The **reproduce** transition (`src/routes/admin/review.ts`) keeps a `FOR UPDATE` eligibility re-check and a fallback allocation only to backfill legacy rows that reached that step without a number.
- `freeEahNumber(tx, submissionId)` — NULLs the number and returns it to the pool. Called when a submission is **withdrawn** back to draft, or rejected/demoted. Must be in the same tx as the status flip. A no-op (safe) for rows that never had a number.
- Owner-deleting an *active* (canonical) entry from `/admin/all` **retires** the number (not recycled into pool).
- `GET /e/:id` accepts A-numbers or the `public_id` slug (10-char base64url). Because every non-draft now has a number, a slug for any public entry 301s to its canonical A-number URL.

**Owner routes are slug-addressed.** Because most submissions have no A-number, the `/my/submissions/:id/*` family resolves `ctx.params.eahId` as a `public_id` (the param name is legacy; `fetchOwned` queries `WHERE public_id = ?`). Don't assume a row has an A-number when building owner-facing URLs.

## Accounts

- **Passwords:** argon2id via `Bun.password`. Non-argon2 hashes verify false. Don't import bcryptjs.
- **Google OAuth:** GIS embedded button posts an ID token to `/oauth/google/verify`. `src/oauth-google.ts` validates locally against Google's JWKS (RS256, checks issuer/audience/expiry/`email_verified`).
- **Email verification:** 6-digit code, 15-min TTL, 5-attempt cap, sha256-hashed in `email_verifications`. Sessions aren't created until verification succeeds.
- **Enumeration resistance:** `/signup` always redirects to `/verify` regardless of whether the email already exists.
- **Resend cap:** `emailCapReached()` in `src/email.ts` guards against exceeding `EMAIL_MONTHLY_CAP` (default 280 of the 300/month free tier).
- **Bootstrap admin:** `scripts/seed-admin.ts` upserts from `ADMIN_BOOTSTRAP_{USER,EMAIL,PASS}`.

## Submission & review flow

Submission is account-only. `/submit` redirects anonymous users to `/login`.

**Tiered trust ladder (iNaturalist-style).** Two orthogonal columns: `status` (moderation axis) and `repro_status` (reproduction axis, only meaningful once `reviewed`). The DB column *values* are unchanged; the **display names** were renamed (lifecycle `draft → pending review → pending acceptance → active`, with `rejected` off either review step). The tiers:

| Display tier | `status` | `repro_status` | A-number | Listed by default? |
|---|---|---|---|---|
| Private draft | `draft` | `pending` | no | owner only |
| **Pending review** | `unreviewed` | `pending` | yes | no — hidden, reachable by link/A-number + opt-in `?pending=1` |
| **Pending acceptance** | `reviewed` | `pending` | yes | no — hidden, same opt-in |
| **Active (canon)** | `reviewed` | `reproduced` | yes | **yes** |
| Rejected (couldn't reproduce) | `reviewed` | `failed` | yes | no — reachable by link only |

Only `active` (`reviewed`+`reproduced`) appears in the default public listings. Every non-draft has an A-number regardless of tier.

`entry_status` (`active`/`patched`) is a *third*, independent axis (does the model still do it). Note the name overlap: the trust-tier display name "active" (= `reviewed`+`reproduced`) is distinct from the `entry_status='active'` column value; a top-tier entry whose behavior later stops reproducing is shown as **patched**.

- **Lifecycle:** submit → `draft` (private) or `unreviewed` = *pending review* (public by link, allocates the A-number). Staff **confirm** (`unreviewed→reviewed` = *pending acceptance*, requires a category) or **reject** (hard-deletes the row). Then staff attempt reproduction: **reproduce** (`→reproduced` = *active*; the public listing + Discord announcement fire here, NOT at confirm) or **fail** (`→failed`, shown as *rejected* but row kept). Link/social-media submissions **cap at pending acceptance** (can't be reproduced).
- **Legacy enum values** `pending`/`published` are kept in the `status` ENUM only so the one-shot data migration can read old rows; no live row should reference them. `withdrawn` survives as a back-compat value.
- **Visibility = active only** in default listings (browse default `status='reviewed' AND repro_status='reproduced'`, opt-in `?pending=1` widens to include pending review + pending acceptance; entry page 404s only for `draft`/rejected-deleted; RSS/sitemap/home-count/suggestions = active canon only). Grep for `repro_status='reproduced'` before adding a public listing.
- **Cap:** `MAX_PENDING_PER_USER = 5` on `unreviewed` (pending-review) submissions per user. Drafts unlimited.
- **Two submit buttons:** "Save as draft" (→ slug edit page) and "Submit for review" (→ dashboard, lands `unreviewed`). A submission is either a pasted transcript or a **link** (`submission_kind=link` → `transcript_mode='link'` + `source_url`; requires a `summary` for link-rot insurance; link entries aren't editable via the transcript editor).
- **Withdraw:** `unreviewed→draft`, keeps discussion. **Delete:** draft-only, hard-deletes row.
- **Staff editing** requires `allow_author_edits = 1`. Reviewed entries are owner-editable only for content; staff can still flip `active`/`patched` via the status endpoint (A-number-addressed, so reproduced entries only).
- `submission_messages`: `sender_type` = `staff` / `user` / `system`. System rows auto-post on every tier transition (the human-readable transition audit trail; version-diffs remain content-only).

See `docs/ROUTES.md` for the full route table.

## Roles

Three levels: normal user, **staff** (`is_admin=1`), **owner** (`is_owner=1`). `isAdmin` = staff OR owner; `ctx.owner` = owner only.

- Staff manage the submission queue; they cannot mutate accounts.
- All account mutations require `ctx.owner`. Last owner is protected from deletion/demotion.
- Email addresses hidden from non-owner staff.
- First owner: `UPDATE users SET is_owner = 1 WHERE username = '...';`
- **Timeouts:** `suspended_until` + `suspended_reason`. Timed-out users can log in and manage drafts but can't submit or propose.

## Database schema

`scripts/migrate.ts` is the **only schema source of truth** — idempotent and additive. To add a column: add to `COLUMN_ADDITIONS` using `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`. Never drop columns in this script; use a separate manual script for destructive changes.

Key `submissions` columns: `eah_number` (NULL until reproduced), `public_id` (slug; primary owner-route key), `owner_user_id`, `prompt`, `output`, `ai_model`, `category` (empty string = uncategorized), `status` (`draft`/`unreviewed`/`reviewed`/`rejected`; legacy `pending`/`published`/`withdrawn` still in the enum), `repro_status` (`pending`/`reproduced`/`failed`), `entry_status` (`active`/`patched`), `transcript_mode` (`single`/`turns`/`block`/`link`), `source_url` (link submissions), `anon_public`, `allow_author_edits`, `ip_hash`, `rejection_reason`, `reviewer_notes`.

The migration is idempotent: `COLUMN_ADDITIONS` adds `repro_status`/`source_url` and `MODIFY`s the `status`/`transcript_mode` enums; `migrateStatusTiers()` then rewrites legacy rows once (`published→reviewed+reproduced` keeping numbers; `pending→unreviewed` and `draft`/`withdrawn` freeing numbers).

Other tables: `user_sessions`, `email_verifications`, `tags`, `submission_tags`, `submission_messages`, `submission_versions`, `submission_turns`, `freed_eah_numbers`, `complaints`.

## Multi-turn transcripts

A submission can hold an **optional multi-turn conversation** (up to `MAX_TURNS = 100`, mainly for short 2–4 turn chats) instead of the legacy single `prompt`/`output` pair. Pure logic lives in `src/turns.ts` (unit-tested in `test/turns.test.ts`); DB read/write helpers in `src/turns-db.ts`.

- **Data model (additive only):** `submissions.transcript_mode` ENUM(`single`/`turns`/`block`/`link`) DEFAULT `single`; legacy `prompt`/`output` columns are **kept**. `link` is the social-media-link shape: no turns, empty `prompt`/`output`, content lives in `source_url` + `summary`; renderers special-case it (grep `transcript_mode === "link"`). `submission_turns` (FK→submissions ON DELETE CASCADE, `turn_index` 0-based, `role` `user`/`assistant`, `content` MEDIUMTEXT). `single` rows (incl. all legacy) have no turn rows. `turns`/`block` rows store turns AND **mirror** the first user/assistant turn into `prompt`/`output` (`deriveLegacyPair`) so the NOT NULL constraint and browse `q` LIKE search keep working. The trivial shape (lone turn, or exactly `[user, assistant]`) collapses back to `single` via `isSimplePair()` — the common case never creates turn rows.
- **Two input modes** (`renderTranscriptFields`, radio toggle): **separate turns** (`turn_role[]` + `turn_content[]`, paired by index) or **pasted block** (`transcript_block`, split on `### User`/`### Assistant` delimiter lines, also `<<USER>>`/`<<ASSISTANT>>`, via `splitBlock()`). `readTranscriptForm()` parses either out of the urlencoded body (repeated fields via `.getAll()`); content is `sanitizeText()`-scrubbed; `validateTurns()` enforces ≥1 non-empty turn, per-turn ≤ `MAX_TURN_CONTENT` (32000), ≤ `MAX_TURNS`.
- **Client JS (`src/static/turns.js`)** is progressive enhancement only (toggles turns-vs-block region, clones/removes turn boxes). With JS off, "Add/Remove turn" are plain `name="action"` submit buttons (`add_turn`/`remove_turn:N`) the POST handlers detect via `applyTurnAction` and re-render server-side, no save. Registered in `STATIC_FILES` + `deploy.sh` purge list.
- **Rendering is shared** so `.entry-card` stays consistent (grep `entry-card`/`conversation`). `effectiveTurns()` synthesizes a `[prompt, output]` pair for `single` rows so all renderers are uniform. `renderConversation(turns, longField, collapseThreshold)`: simple pair labels **"Prompt"/"Response"**, richer ones **"User"/"Assistant"**. Entry page + overview show the full conversation; browse/home/dashboard cards (`renderCardConversation`, exported from `browse.ts`) collapse past the first two turns behind a pure-CSS `<details>`. Cards batch-load turns in one `WHERE submission_id IN (...)` query, only for `transcript_mode != 'single'` rows.
- **Version-diff audit:** `versions.ts` has a `transcript` tracked field, set via `serializeTranscript(mode, turns)` (null for `single`). Staff direct-add (`/admin/entries/*`) is single-turn only by design.

## Email and Discord

Both `src/email.ts` and `src/discord.ts` share the same contract: **every exported function returns `Promise<void>` and never throws**. Failures log and are discarded — a failed send must not break submit or review. Both no-op when their token env var is unset.

**Debugging silent send failures (e.g. "emails aren't sending"):** because failures are logged-and-discarded, nothing surfaces in the UI — diagnose via the host: `ssh enaih 'cd /root/eah && docker compose logs --tail=200 eah'` and grep for Resend/email errors. Note `send()` logs **only on failure** (`console.error`); a successful send is silent, so "no email log lines" does NOT mean "no email sent" — confirm by checking the inbox, not the logs. As of the DO migration `RESEND_API_KEY`, `GOOGLE_CLIENT_ID`, and `DISCORD_BOT_TOKEN` are all populated on `enaih` (re-entered by hand after `bootstrap.sh` generated a blank `.env`), so a *missing* key is NOT the cause.

**Resolved 2026-06-02 — the canonical send-domain config.** After the DO migration, sends failed with Resend `400 — The associated domain with your API key is not verified`. It was **two stacked problems**: (1) the hand-re-entered `EMAIL_FROM` pointed at the unverified `eah.warrenwoolf.com` instead of the verified site domain; (2) the Resend **API key itself was scoped to that same unverified domain**, so it 400s regardless of the From address. Fix that's now live on `enaih`: `EMAIL_FROM=ENAIH <noreply@enaih.org>` and a Resend key scoped to (or with full access including) the verified **`enaih.org`** domain. **`enaih.org` is the canonical, verified send domain — `eah.warrenwoolf.com` was never verified; don't reintroduce it.** Fastest isolation when this recurs: bypass the app and hit Resend directly with the live creds — `ssh enaih 'cd /root/eah && curl -s -X POST https://api.resend.com/emails -H "Authorization: Bearer <key-from-.env>" -H "Content-Type: application/json" -d "{\"from\":\"ENAIH <noreply@enaih.org>\",\"to\":\"...\",\"subject\":\"t\",\"text\":\"t\"}"'` — a returned `id` means key+From+domain are good and the problem is elsewhere; a `400` points back at key-scope/domain. Other suspects if the key checks out: `EMAIL_MONTHLY_CAP` (280) reached (cap cache is in-memory, fails open, resets on restart). Remember the container reads `.env` at boot — `docker compose up -d eah` to reload after editing it.

Email triggers: submission received, reviewer message, decision (confirm/reject `sendDecision`; reproduce/fail go out as `sendReviewerMessage`), reader complaint (to staff inbox).

Discord triggers: new submission enters queue → staff channel; entry becomes `active` (reproduced — the point it enters the public listings) → public channel (`notifyPublished`, fired in the **reproduce** transition, linked by its A-number); complaint filed → staff channel. `src/discord-gateway.ts` opens a gateway WebSocket with `intents: 0` solely to keep the bot showing as online; it heartbeats and reconnects silently.

## Deploy

```sh
./deploy.sh   # rsync → host, docker compose up --build, migrate, purge Cloudflare cache
```

Host is SSH alias `randy` (temporary homelab box). Don't hardcode it in source. Public URL: `https://enaih.org`. Internal identifiers stay `EAH`.

**Cloudflare caches `/static/*` aggressively (4h edge TTL).** `deploy.sh` purges static assets automatically after the build. The purge token needs *Zone → Cache Purge* and *Zone Read* on `enaih.org`. Keep the URL list in `deploy.sh` in sync with `STATIC_FILES` in `src/server.ts`.

`deploy.sh` takes `DEPLOY_HOST` (SSH alias, default `randy`): `DEPLOY_HOST=enaih ./deploy.sh`.

## Migrating to a new host

The Pi (`randy`) has been replaced by a cloud VPS — a **DigitalOcean droplet, live as SSH alias `enaih`** (`User root`, app in `/root/eah`); Oracle Ampere was blocked by A1 capacity. Deploy with `DEPLOY_HOST=enaih ./deploy.sh`. The old Pi `randy` is being decommissioned (still powered on as of the migration; its MariaDB is the only remaining copy of a few legacy entries until they're restored — don't wipe it yet). The host layer (Docker, MariaDB, cloudflared) lives **outside** compose — `bootstrap.sh` reproduces it. DO is the credit-funded stopgap (GitHub Student Pack, 1 yr); the long-term home may be a Pi 5 / owned hardware — which is why `bootstrap.sh` (portable to any Ubuntu host) is the durable artifact and `provision-do.sh` (DO-API-specific) is not.

- **`.env` does not transfer between hosts** (deploy excludes it; `bootstrap.sh` generates a fresh one with blank optional-integration keys). After provisioning a new box, the Resend / Google OAuth / Discord secrets must be re-entered by hand in `<APP_DIR>/.env`. On the current `enaih` box they are already populated.

- **`provision-do.sh`** (laptop-side, optional): creates/finds the droplet via the DO API, reads `$DO_API_TOKEN` (use a *scoped* token: droplet:create,droplet:read,ssh_key:read), idempotent by tag, prints the IP. Does not configure the box — hand off to `bootstrap.sh`. **DO Ubuntu images log in as `root`** (not `ubuntu` like Oracle), so the `enaih` SSH alias uses `User root` and `APP_DIR` defaults to `/root/eah`.

- **Networking is cloudflared-tunnel-only.** `cloudflared` dials *out* to Cloudflare on 7844; nothing connects in. **No public IP or open ingress port is needed** — MariaDB stays on `127.0.0.1`, the `eah` container reaches it via `network_mode: host`, and cloudflared is the sole public path. Don't open security-group/firewall ingress. SSH also rides the tunnel (`ssh://localhost:22` route + Cloudflare Access); the `enaih` SSH alias uses `ProxyCommand cloudflared access ssh`. Recovery if the tunnel dies: the provider's web/serial console.
- **`bootstrap.sh`** (run once on a fresh Ubuntu 24.04 box, arch-agnostic): installs Docker + compose, MariaDB (loopback-bound, creates the `eah` db/user on both `localhost` and `127.0.0.1`), cloudflared (systemd service via `TUNNEL_TOKEN`), and generates `~/eah/.env` with fresh `DB_PASSWORD`/`SESSION_SECRET`. Idempotent: secrets generated once, never rotated on re-run. Don't `source` the generated `.env` in bash — it's docker `env_file` format (unquoted spaces in `EMAIL_FROM` etc.); extract keys with grep instead.
- **`rsync --delete` blast radius:** `deploy.sh` syncs into `~/eah/` with `--delete`, so anything stateful created there that isn't in git gets wiped. Excluded: `.env`, `backups`, `.backup-par`, `.spaces`. Add new host-side state files to the `--exclude` list when you create them.
- **Backups:** `scripts/backup-db.sh` dumps + gzips + rotates MariaDB locally (`~/eah/backups`, 14-day retention), then optionally uploads off-box. Scheduled by a **systemd timer on `enaih`** (`eah-backup.timer`, daily 03:17 UTC, `Persistent=true` so it catches up on boot) — *not* cron. Two off-box targets, each optional and gated on its own creds file: **DigitalOcean Spaces** (S3 via `s3cmd`, creds in `~/eah/.spaces`; bucket made by `provision-spaces.sh`) is the current one; an Oracle Object-Storage **PAR** (`~/eah/.backup-par`) path also exists from the Oracle era. Both are host-side **ops** secrets, not app config — never in `.env` (container config). Spaces creds (the *Spaces* access key, distinct from the droplet `DO_API_TOKEN`) are generated in DO panel → API → Spaces Keys. Backups are **age-encrypted at creation** (`scripts/backup-db.sh` pipes the dump through `age -r <recipient>` when `~/eah/.backup-age-pub` holds a public key), so artifacts are `*.sql.gz.age` and the only plaintext copy of the data is the live MariaDB. The **public** key sits on the box (it can't decrypt — public keys aren't secret); the **private** key lives OFF the box (password manager + encrypted laptop), never on the host and never in git/`.env`. If no recipient is configured the script falls back to unencrypted `*.sql.gz` with a warning. Restore drill: `age -d -i <private-key-file> < dump.sql.gz.age | gunzip | sudo mysql <throwaway_db>` (drop the `age -d` stage for legacy unencrypted `.sql.gz` dumps) then check row counts (the `eah` DB user is scoped to `eah` only, so drills need root/socket).

## Launch state (pre-launch)

These two travel together — flip both in the same deploy:

- **`src/static/robots.txt`** is `Disallow: /`. To launch: empty `Disallow:`, keep `Sitemap:`.
- **`IN_DEVELOPMENT` env flag** (default `true`): set to `false` in prod `.env` to remove the banner.

## Testing

- `bun test` — unit tests with mocked DB.
- `EAH_TEST_DB=1 bun test test/integration/` — integration tests with a throwaway MariaDB in Docker.
- `scripts/smoke.sh up` — starts MariaDB, runs migrations, seeds `owner`/`staff`/`user` accounts (password `smoke-pass-1234`) and sample data, boots server on :8099, prints session cookies per role. `down` / `reset` / `sql '<q>'` / `cookies` also available.

**`mock.module` bleeds across test files** in Bun — it installs live bindings process-wide. When mocking a widely-imported module (`src/config.ts`, `src/db.ts`), save the real one and restore in `afterAll`. Don't assert the *default value* of something another file may mock — assert the shape instead, or the test becomes order-dependent.

## House style

See `docs/HOUSE-STYLE.md` for the full CSS/UI guide. Critical rules:

- **No transitions, animations, or JS-driven visual effects.**
- **No client JS beyond `theme.js` and `browse.js`.** Account dropdown is pure CSS.
- **Three theme CSS blocks must stay in var-parity:** `:root`, auto-dark `@media (prefers-color-scheme: dark)`, and explicit `[data-theme="dark"]`. Add a `--var` to one dark block → update the other too or OS-dark users get mismatched colors.
- **`entry-card` changes ripple** across browse, home, dashboard, and entry page. Grep before editing.
- All HTML through `h\`\``. When reviewing a diff, search `+` lines for `<` and verify they're inside `h\`\``.
- Dates: `YYYY-MM-DD` (UTC) user-facing; `YYYY-MM-DD HH:MM:SS UTC` admin-facing.
- Staff copy: terse lowercase. User copy: sentence-case prose.

## Do not

- Bypass `h\`\`` for HTML output (XSS chokepoint).
- Drop columns in `scripts/migrate.ts`.
- Interpolate user values into SQL.
