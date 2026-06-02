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

`submissions.eah_number` (nullable INT) is displayed as `A######` (6-digit zero-padded). **A-numbers are the canon: they are allocated ONLY when a `reviewed` entry is marked `reproduced`** (the top tier — see "Submission & review flow"). Everything below that tier (draft / unreviewed / reviewed-not-reproduced / failed) has `eah_number = NULL` and is addressed by its `public_id` slug. Helpers in `src/eah-id.ts`:

- `allocateEahNumber(tx)` — pops MIN from `freed_eah_numbers` if any, else `MAX+1`. Called in the **reproduce** transition (`src/routes/admin/review.ts`), inside the same tx as the `repro_status='reproduced'` flip. Re-read the row `FOR UPDATE` and check eligibility (status `reviewed`, not `link` mode, `eah_number IS NULL`) **before** allocating, so an ineligible action doesn't leak a number.
- `freeEahNumber(tx, submissionId)` — NULLs the number and returns it to the pool. Called when a reproduced entry is demoted or rejected. Must be in the same tx as the status flip. A no-op (safe) for rows that never had a number.
- Owner-deleting a *reproduced* (canonical) entry from `/admin/all` **retires** the number (not recycled into pool).
- `GET /e/:id` accepts A-numbers or the `public_id` slug (10-char base64url). A slug for a reproduced entry 301s to the canonical A-number URL; slugs for lower tiers serve directly (they have no A-number).

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

**Tiered trust ladder (iNaturalist-style).** Two orthogonal columns: `status` (moderation axis) and `repro_status` (reproduction axis, only meaningful once `reviewed`). The tiers:

| Tier | `status` | `repro_status` | A-number | Public? |
|---|---|---|---|---|
| Private draft | `draft` | `pending` | no | owner only |
| Unreviewed | `unreviewed` | `pending` | no | yes, but hidden from default lists (link + opt-in toggle) |
| Reviewed, not reproduced | `reviewed` | `pending` | no | yes (default lists) |
| **Reproduced (canon)** | `reviewed` | `reproduced` | **yes** | yes |
| Failed to reproduce | `reviewed` | `failed` | no | yes |

`entry_status` (`active`/`patched`) is a *third*, independent axis (does the model still do it).

- **Lifecycle:** submit → `draft` (private) or `unreviewed` (public). Staff **confirm** (`unreviewed→reviewed`, requires a category) or **reject** (hard-deletes the row). Then staff attempt reproduction: **reproduce** (`→reproduced`, allocates the A-number) or **fail** (`→failed`). Link/social-media submissions **cap at `reviewed`** (can't be reproduced).
- **Legacy enum values** `pending`/`published` are kept in the `status` ENUM only so the one-shot data migration can read old rows; no live row should reference them. `withdrawn` survives as a back-compat value.
- **Visibility = `reviewed`+** everywhere public (browse default `status='reviewed'`, opt-in `?unreviewed=1` widens to include `unreviewed`; entry page 404s only for `draft`; RSS/sitemap = reproduced canon only). Grep for `status = 'reviewed'` before adding a public listing.
- **Cap:** `MAX_PENDING_PER_USER = 5` on `unreviewed` submissions per user. Drafts unlimited.
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

Discord triggers: new submission enters queue → staff channel; entry reaches `reviewed` (becomes publicly listed) → public channel (`notifyPublished`, linked by slug since there's no A-number yet); complaint filed → staff channel. `src/discord-gateway.ts` opens a gateway WebSocket with `intents: 0` solely to keep the bot showing as online; it heartbeats and reconnects silently.

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
- **`rsync --delete` blast radius:** `deploy.sh` syncs into `~/eah/` with `--delete`, so anything stateful created there that isn't in git gets wiped. Excluded: `.env`, `backups`, `.backup-par`. Add new host-side state files to the `--exclude` list when you create them.
- **Backups:** `scripts/backup-db.sh` (cron'd) dumps + gzips + rotates MariaDB locally and optionally uploads to Object Storage via a Pre-Authenticated Request URL. Like the Cloudflare purge token, the PAR is host-side **ops** config, not app config — it lives in `~/eah/.backup-par` (or `OBJECT_STORAGE_PAR_FILE`), never in `.env` (which is container config).

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
