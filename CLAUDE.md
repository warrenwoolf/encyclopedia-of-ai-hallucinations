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

Every submission has `submissions.eah_number` (nullable INT), displayed as `A######` (6-digit zero-padded). Helpers in `src/eah-id.ts`:

- `allocateEahNumber(tx)` — pops MIN from `freed_eah_numbers` if any, else `MAX+1`. **Must be in the same transaction that inserts the row** — leaks on contention otherwise.
- `freeEahNumber(tx, submissionId)` — NULLs the number and adds to pool. Called on **reject** and **draft delete**. Must be in the same tx as the status flip.
- **Withdraw** (pending→draft) does NOT free the number.
- Owner-deleting a *published* entry from `/admin/all` **retires** the number (not recycled into pool).
- `GET /e/:id` accepts A-numbers or the legacy `public_id` slug (10-char base64url); legacy path 301s to canonical.

## Accounts

- **Passwords:** argon2id via `Bun.password`. Non-argon2 hashes verify false. Don't import bcryptjs.
- **Google OAuth:** GIS embedded button posts an ID token to `/oauth/google/verify`. `src/oauth-google.ts` validates locally against Google's JWKS (RS256, checks issuer/audience/expiry/`email_verified`).
- **Email verification:** 6-digit code, 15-min TTL, 5-attempt cap, sha256-hashed in `email_verifications`. Sessions aren't created until verification succeeds.
- **Enumeration resistance:** `/signup` always redirects to `/verify` regardless of whether the email already exists.
- **Resend cap:** `emailCapReached()` in `src/email.ts` guards against exceeding `EMAIL_MONTHLY_CAP` (default 280 of the 300/month free tier).
- **Bootstrap admin:** `scripts/seed-admin.ts` upserts from `ADMIN_BOOTSTRAP_{USER,EMAIL,PASS}`.

## Submission & review flow

Submission is account-only. `/submit` redirects anonymous users to `/login`.

- **Status flow:** `draft` ⇄ `pending` (submitter propose/withdraw) → `published` | `rejected` (staff). A draft can be deleted outright.
- **Pending cap:** `MAX_PENDING_PER_USER = 5`. Drafts are unlimited. Cap re-checked on propose.
- **Two submit buttons:** "Save as draft" (→ edit page) and "Submit for review" (→ dashboard).
- **Category** is optional at submit; staff must assign one before approving. Direct-add (`/admin/entries/*`) requires it immediately.
- **Withdraw:** pending→draft, keeps discussion and A-number. **Delete:** draft-only, hard-deletes row and recycles A-number.
- **Staff editing** requires `allow_author_edits = 1`. Published entries are owner-editable only for content; staff can still flip `active`/`patched` via the status endpoint.
- `submission_messages`: `sender_type` = `staff` / `user` / `system`. System rows auto-post on status transitions.

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

Key `submissions` columns: `eah_number`, `public_id` (legacy slug), `owner_user_id`, `prompt`, `output`, `ai_model`, `category` (empty string = uncategorized), `status` (`draft`/`pending`/`published`/`rejected`/`withdrawn`), `entry_status` (`active`/`patched`), `transcript_mode` (`single`/`turns`/`block`), `anon_public`, `allow_author_edits`, `ip_hash`, `rejection_reason`, `reviewer_notes`.

Other tables: `user_sessions`, `email_verifications`, `tags`, `submission_tags`, `submission_messages`, `submission_versions`, `submission_turns`, `freed_eah_numbers`, `complaints`.

## Multi-turn transcripts

A submission can hold an **optional multi-turn conversation** (up to `MAX_TURNS = 100`, mainly for short 2–4 turn chats) instead of the legacy single `prompt`/`output` pair. Pure logic lives in `src/turns.ts` (unit-tested in `test/turns.test.ts`); DB read/write helpers in `src/turns-db.ts`.

- **Data model (additive only):** `submissions.transcript_mode` ENUM(`single`/`turns`/`block`) DEFAULT `single`; legacy `prompt`/`output` columns are **kept**. `submission_turns` (FK→submissions ON DELETE CASCADE, `turn_index` 0-based, `role` `user`/`assistant`, `content` MEDIUMTEXT). `single` rows (incl. all legacy) have no turn rows. `turns`/`block` rows store turns AND **mirror** the first user/assistant turn into `prompt`/`output` (`deriveLegacyPair`) so the NOT NULL constraint and browse `q` LIKE search keep working. The trivial shape (lone turn, or exactly `[user, assistant]`) collapses back to `single` via `isSimplePair()` — the common case never creates turn rows.
- **Two input modes** (`renderTranscriptFields`, radio toggle): **separate turns** (`turn_role[]` + `turn_content[]`, paired by index) or **pasted block** (`transcript_block`, split on `### User`/`### Assistant` delimiter lines, also `<<USER>>`/`<<ASSISTANT>>`, via `splitBlock()`). `readTranscriptForm()` parses either out of the urlencoded body (repeated fields via `.getAll()`); content is `sanitizeText()`-scrubbed; `validateTurns()` enforces ≥1 non-empty turn, per-turn ≤ `MAX_TURN_CONTENT` (32000), ≤ `MAX_TURNS`.
- **Client JS (`src/static/turns.js`)** is progressive enhancement only (toggles turns-vs-block region, clones/removes turn boxes). With JS off, "Add/Remove turn" are plain `name="action"` submit buttons (`add_turn`/`remove_turn:N`) the POST handlers detect via `applyTurnAction` and re-render server-side, no save. Registered in `STATIC_FILES` + `deploy.sh` purge list.
- **Rendering is shared** so `.entry-card` stays consistent (grep `entry-card`/`conversation`). `effectiveTurns()` synthesizes a `[prompt, output]` pair for `single` rows so all renderers are uniform. `renderConversation(turns, longField, collapseThreshold)`: simple pair labels **"Prompt"/"Response"**, richer ones **"User"/"Assistant"**. Entry page + overview show the full conversation; browse/home/dashboard cards (`renderCardConversation`, exported from `browse.ts`) collapse past the first two turns behind a pure-CSS `<details>`. Cards batch-load turns in one `WHERE submission_id IN (...)` query, only for `transcript_mode != 'single'` rows.
- **Version-diff audit:** `versions.ts` has a `transcript` tracked field, set via `serializeTranscript(mode, turns)` (null for `single`). Staff direct-add (`/admin/entries/*`) is single-turn only by design.

## Email and Discord

Both `src/email.ts` and `src/discord.ts` share the same contract: **every exported function returns `Promise<void>` and never throws**. Failures log and are discarded — a failed send must not break submit or review. Both no-op when their token env var is unset.

Email triggers: submission received, reviewer message, approve/reject decision, reader complaint (to staff inbox).

Discord triggers: new submission enters queue → staff channel; entry published → public channel; complaint filed → staff channel. `src/discord-gateway.ts` opens a gateway WebSocket with `intents: 0` solely to keep the bot showing as online; it heartbeats and reconnects silently.

## Deploy

```sh
./deploy.sh   # rsync → host, docker compose up --build, migrate, purge Cloudflare cache
```

Host is SSH alias `randy` (temporary homelab box). Don't hardcode it in source. Public URL: `https://enaih.org`. Internal identifiers stay `EAH`.

**Cloudflare caches `/static/*` aggressively (4h edge TTL).** `deploy.sh` purges static assets automatically after the build. The purge token needs *Zone → Cache Purge* and *Zone Read* on `enaih.org`. Keep the URL list in `deploy.sh` in sync with `STATIC_FILES` in `src/server.ts`.

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
