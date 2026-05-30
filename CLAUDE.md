# CLAUDE.md — orientation for future Claudes

You're working on the **Encyclopedia of AI Hallucinations (EAH)**: an OEIS-inspired, community-submitted, staff-reviewed catalog of LLM hallucinations. Read README.md for the user-facing story. This file is the "what you actually need to know to make changes safely" file.

Co-founders: **Rudra Jadhav** and **Warren Woolf** (`warrenwoolf` on GitHub). The site footer credit and About page reflect this.

## Stack and conventions

- **Bun + TypeScript.** No build step. `bun run dev` (hot reload) or `bun src/server.ts`. Type-check with `bunx tsc --noEmit`.
- **Server-rendered HTML.** No client framework. One small vanilla-JS file (`src/static/theme.js`) for the dark-mode toggle. Don't add more client JS without a real reason — the *JS* surface is deliberately minimal (the CSS is allowed to be richer; see House style).
- **MariaDB** via the `mariadb` npm driver. Everything goes through `src/db.ts` (`query`, `queryOne`, `execute`, `transaction`). Always pass user values as `?` parameters; never interpolate into SQL.
- **HTML rendering is XSS-safe via `h\`...\``** in `src/html.ts`. ALL HTML output goes through `h\`\`` or `raw()`. `raw()` is for constants you fully control — never on user input. Do not concatenate user strings into HTML, ever.
- **CSRF:** HMAC-signed double-submit cookie + hidden field. Every form must include `<input type="hidden" name="_csrf" value="${csrfToken}">` and the handler must call `verifyCsrf(req, form.get("_csrf"))` before doing anything mutating.
- **`parseForm()` only understands `application/x-www-form-urlencoded`** — it runs the raw body through `new URLSearchParams(text)`. It does NOT parse `multipart/form-data`. So any client-side POST (e.g. `fetch` in `google.js`) must send a urlencoded body (`URLSearchParams`, not `FormData`), or every field — including `_csrf` — comes back empty and the request 403s on the CSRF check. That 403 branch logs nothing, so the failure is silent: the symptom is a POST that bounces back with no server log. This bit the GIS login flow (button rendered, sign-in always redirected to `/login`).
- **Rate-limiting:** in-memory token bucket per IP in `src/ratelimit.ts`. Buckets: `submit`, `login`, `signup`, `verify`, `oauth`, `withdraw`, `lookup`. Add a new bucket entry if you add a new POST that hits external services or writes to the DB on behalf of anonymous users.
- **Sessions:** all users (admins are users with `is_admin=1`). Cookie holds a random token; DB stores only its sha256. Logic in `src/auth.ts`.

## Security model — do not weaken

- **CSP:** strict. Don't relax to `'unsafe-inline'` without a very good reason.
- **No raw IPs stored.** `ip_hash` is `sha256(SESSION_SECRET || ip)`. The Cloudflare `cf-connecting-ip` header is honored ONLY when the immediate TCP peer is loopback (cloudflared on the same host). Never trust `X-Forwarded-For`.
- **Tracking codes** are 24-char base64url. Only the sha256 is stored in `submissions.tracking_hash`. The plaintext is additionally stored in `submissions.notify_token` BUT ONLY when the submitter gave an email (so `/lookup` can rebuild tracking links). Submissions without an email keep the hash-only model.
- **Trojan-source / control-char scrub:** all user text passes through `sanitizeText()` in `src/routes/types.ts` before storage. Strips C0/C1 controls (except tab/LF/CR), BiDi overrides, zero-width chars, BOM.
- `multipleStatements: false` on the DB pool.

## The A-number system (most distinctive piece)

Every submission has `submissions.eah_number` (nullable INT). Displayed everywhere as `A` + 6-digit zero-padded → `A000001`. Helpers in `src/eah-id.ts`:

- `allocateEahNumber(tx)` — pops MIN from `freed_eah_numbers` if any, else uses `MAX(eah_number) + 1`. **Must be called inside the same transaction that inserts the row claiming the number**, otherwise it leaks on contention.
- `freeEahNumber(tx, submissionId)` — sets `eah_number = NULL` on the row and inserts the integer into `freed_eah_numbers`. Called on **reject** and on **draft delete** (`myDelete`, which then hard-deletes the row). (Submitter **withdraw** is now pending→draft and does NOT free the number.) Must be in the same transaction as the status flip/delete — never expose a `rejected`-with-live-A-number state to readers.
- `formatEahId(n)` / `parseEahId(s)` — format/parse the `A######` string.

Allocation rules (matches OEIS):
- Allocated at **draft creation** (submit time).
- Freed (recycled into the pool) on **reject** and on **draft delete**.
- Locked permanently on **publish**. (Owner deleting a *published* entry from `/admin/all` **retires** the number instead — it is NOT recycled; see the all.ts delete handler.)

The migration's `backfillEahNumbers()` step assigns numbers to existing `pending`/`published` rows in (`submitted_at`, `id`) order. It deliberately skips `rejected`/`withdrawn` rows so they don't consume numbers in the new scheme.

Legacy `submissions.public_id` (random 10-char base64url) is still generated for new rows for back-compat with any URL that was shared while the old scheme was live. `GET /e/:id` accepts either an A-number or a legacy public_id; the legacy path 301-redirects to the canonical `A######` URL.

## Accounts

Single `users` table — admins are just `is_admin=1` rows. There is no separate admins table (it was dropped via `scripts/drop-legacy.ts`).

Auth model:

- **Passwords:** argon2id via `Bun.password.hash` / `Bun.password.verify`. **No bcrypt** — verification of any non-argon2 hash returns false. If you find yourself needing to import bcryptjs, stop and add a password-reset flow instead.
- **Google OAuth / Sign-in:** now uses Google Identity Services (GIS) embedded button (`src/oauth-google.ts` verifies ID tokens). The client renders the official GIS button and posts the ID token (credential) to `/oauth/google/verify`; the server verifies the token, enforces `email_verified`, then links or creates the user and issues a session. The legacy arctic-based redirect/PKCE flow has been removed. **ID-token verification is local:** `verifyIdToken` validates the JWT against Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`) using Bun's WebCrypto — no `tokeninfo` round-trip. The algorithm is pinned to RS256 (only RSA verify keys are ever imported, so `alg: none`/`HS256` confusion is rejected before key selection); the signature is checked before any claim is trusted; then issuer, audience (= our client id), expiry (60s skew), and `email_verified` are validated. JWKS keys are cached in memory honoring `Cache-Control: max-age` (clamped 1h–24h); an unknown `kid` triggers at most one refresh per 60s.
- **Email verification:** 6-digit code, 15-minute TTL, 5-attempt cap, in `email_verifications`. Codes are sha256-hashed in the DB; `consumeVerificationCode` does the timing-safe compare and the attempt-counter bookkeeping inside a transaction.
- **Pending-verify cookie:** `eah_pending_verify` is an HMAC-signed cookie carrying `userId` that scopes to `/verify` only. Issued by `/signup` and `/login` when the target user is unverified. `/verify` reads it — sessions are NOT created until verification succeeds.
- **Enumeration resistance:** `/signup` and `/verify/resend` MUST return the same response shape regardless of whether the email is already in use. The /signup POST always redirects to `/verify` with a pending-verify cookie (pointing at the existing user if any, or the newly-created one). Username collisions DO leak — usernames are public and the user needs to know to pick another.

### Resend monthly cap

Free tier is 300 sends/month. We read Resend's `x-resend-monthly-quota` response header after every API call and cache it in `src/email.ts`. `emailCapReached()` returns true when the cached value is ≥ `EMAIL_MONTHLY_CAP` (default 280; set 0 to disable). On cold start `primeQuotaCache()` does a best-effort `GET /domains` to seed the cache; if Resend is unreachable the gate fails open. If we're at cap, `/signup` hides the password form (Google is still offered) and returns 503 when both are unavailable.

### Bootstrap admin

`scripts/seed-admin.ts` upserts a single admin row from `ADMIN_BOOTSTRAP_{USER,EMAIL,PASS}`. It writes only to `users`. Re-running with new values updates the existing row.

## Submission & review flow

**Submission is account-only now.** `/submit` (GET and POST) redirects anonymous visitors to `/login`. There is no anonymous/email-tracking path anymore — the old `/track`, `/lookup`, `/draft/:token`, tracking codes, and `notify_token`/`submitter_email` flows are gone (the columns still exist but new submissions leave them null). Submitter notifications go through the account.

- `/submit` enforces: a cap on submissions **awaiting review** (`MAX_PENDING_PER_USER = 5`, counting `status='pending'`) — drafts are **unlimited** — plus required fields, all length caps, tag format `^[a-z0-9-]+$`, date parsing, URL validation. **Category is OPTIONAL for submitters** (they may leave it blank and let staff categorize); if they do pick one it must be valid. The gate is at publish: `postReview` **refuses to approve a submission with an empty category** (so staff must assign one via the edit form first). Staff direct-add (`/admin/entries/*`) still requires a category since those publish immediately. The cap is only checked on the **Submit for review** path (so a capped user can always still save a draft). The form has **two submit buttons** (`name="action"`): **Save as draft** inserts `status='draft'` and redirects to `/my/submissions/:eahId/edit`; **Submit for review** inserts the row already `status='pending'` (and posts the `proposed` system message) in the same transaction, then redirects to `/my/submissions`.
- **A submission's status flow (simplified model):** `draft` ⇄ `pending` via the submitter's **propose** (draft→pending) and **withdraw** (pending→draft) buttons; staff then move `pending` → `published` | `rejected`. A draft can be **deleted** outright. To discard a proposed submission you withdraw it (back to draft) then delete it — two buttons, no single "withdrawn" path from the dashboard anymore. (`withdrawn` still exists in the enum for legacy rows and is excluded from the dashboard.) `MAX_PENDING_PER_USER` is re-checked on **propose** too (`myPropose`).
- **Drafts and proposed (pending) submissions are equally editable by the owner** — they differ only in whether staff can see them. `myEditGet`/`myEditPost` render/accept the edit form for both; other statuses are read-only (`myEditGet` 303-redirects them to the overview page).
- `/my/submissions` (`src/routes/my.ts`) — the submitter's dashboard, rendered as a list (withdrawn rows excluded — they freed their A-number so detail links would 404). Each row's **A-number links to the overview page** `/my/submissions/:eahId` (`myView`): a single read-only page showing metadata, prompt/output, the discussion thread, and edit history. Every submission page (overview, edit, history, discussion) renders the same shared **action bar** (`actionBar` in `src/routes/my-shared.ts`) so all actions are reachable everywhere. `/my/submissions/:eahId/discussion` (`src/routes/my-discussion.ts`) is the chat thread with reviewers.
- **Withdraw** (`myWithdraw`, `GET` confirm + `POST /my/submissions/:eahId/withdraw`) flips `pending → draft`, **keeps** the discussion and A-number, and posts a `system` message recording the withdrawal. (This replaced the old "unpropose", which used to wipe the discussion — it no longer does.) **Delete** (`myDelete`, `GET` confirm + `POST /my/submissions/:eahId/delete`) is **draft-only**: it hard-deletes the row (children cascade) and recycles its A-number into `freed_eah_numbers`. Both have a GET confirmation page so the action-bar entries can be plain links (no nested `<form>`s).
- `/admin/queue` and `/admin/queue/:id` — staff queue + detail with chat thread. The detail page has a gated "edit this submission" link (see staff-edit rules below). `POST /admin/queue/:id` approves/rejects (and on reject, frees the A-number in the same tx). `POST /admin/queue/:id/message` posts a staff chat message and emails the submitter via `sendReviewerMessage`.
- `/admin/entries/new`, `/admin/entries/:eahId/edit`, `/admin/entries/:eahId/status` — direct staff actions, bypass the draft queue. `:eahId/edit` works on a submission of any status (not just published); on save it redirects to `/e/:eahId` if published, else back to `/admin/queue/:id`.
- **Staff editing someone else's submission** is allowed only when `allow_author_edits = 1` (the submitter opted in). **Published entries are owner-only** — once live, only an owner can edit content via `/admin/entries/:eahId/edit` (staff can still flip active/patched via the status endpoint). The owner can always edit their own; **owners (is_owner=1) can edit anything**; owner-less (legacy / direct) entries are freely editable. Enforced in `src/routes/admin/entries.ts` (`mayEdit`, which now takes the row's `status`).
- `submission_messages` table holds the chat. `sender_type` is `staff` / `user` / `system`. `system` rows are auto-posted on accept/reject/withdraw/propose.

## Roles, accounts management, and timeouts

- **Three privilege levels:** normal user, **staff** (`is_admin=1`), **owner** (`is_owner=1`). `UserSession.isAdmin` is `is_admin=1 OR is_owner=1` (owners reach the whole admin area); `UserSession.isOwner` is owner-only. `ctx.admin` is set for staff+owners; `ctx.owner` is set for owners only.
- **Staff's only privilege over a normal user is managing the submission queue** — not accounts. `/admin/users` and `/admin/staff` are viewable by staff but **read-only** (no action buttons); all mutations (`POST /admin/users/:id`: promote/demote staff, promote/demote owner, suspend/unsuspend, delete) require `ctx.owner`. Owners can add/remove other owners; the last owner can't be removed/deleted.
- **Bootstrapping the first owner is manual** (owner = "has server access"): `UPDATE users SET is_owner = 1 WHERE username = '...';`.
- **Timeouts:** an owner can "time out" a user via `suspended_until` (+ a free-text `suspended_reason` shown to the user). A timed-out user **can still log in and browse and manage existing drafts** — they just can't `/submit` or propose (`src/routes/submit.ts`, `my.ts` `myPropose` gate on `isSuspended`). Suspending does NOT revoke sessions.

## Database schema

`scripts/migrate.ts` is the **only** source of schema truth and is **idempotent + additive**. Adding a column? Add an entry to `COLUMN_ADDITIONS` with `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`. Don't write one-off migration files; don't drop columns in this script. If you need to drop something, write a separate destructive script and run it manually with eyes open.

Key columns on `submissions`:

- `id` (PK), `public_id` (legacy slug), `eah_number` (the A-number), `title`, `tracking_hash` (BINARY(32), legacy/unused for new rows), `notify_token` / `submitter_email` (legacy anonymous-tracking; null for new account submissions).
- `owner_user_id` (FK `users(id)`, ON DELETE SET NULL — the submitter's account).
- `prompt`, `output`, `ai_model`, `summary`, `notes`, `shared_chat_url`, `category` (VARCHAR, NOT NULL; **empty string `''` = uncategorized**, the optional-at-submit state — `categoryLabel("")` renders "uncategorized"; a published entry always has a real category), `hallucination_date`.
- **Public attribution:** by default the entry shows the owner's account **username**. `anon_public` TINYINT (default 0) = "anonymous to public": when 1, the public entry shows "anonymous" and only staff see the submitter. `author_name` is a legacy free-text field, now only used as a display fallback for owner-less rows (staff-created direct entries / legacy data) — the submit/edit forms no longer collect it.
- `allow_author_edits` TINYINT — submitter opt-in that **staff may edit this submission** (see staff-edit rules above). Default 0.
- `entry_status` ENUM('active','patched') — distinct from moderation `status` ENUM('draft','pending','published','rejected','withdrawn') (default 'draft').
- `verified_hits` / `verified_total` — "prompt reproduced N/M times when staff tried it."
- `reviewed_by`, `reviewed_at`, `reviewer_notes` (private), `rejection_reason` (shown to submitter), `staff_review_message` (shown to submitter, included in decision email).
- `ip_hash` (BINARY(32)).

Key columns on `users`: `is_admin` (staff), `is_owner` (owner), `suspended_until` + `suspended_reason` (timeout). Other tables: `user_sessions` (account auth), `email_verifications` (signup codes), `tags` + `submission_tags` join, `submission_messages` (chat; `sender_user_id` FKs `users(id)`), `submission_versions` (edit-diff audit log), `freed_eah_numbers` (A-number pool).

## Email (Resend)

`src/email.ts` is the only outbound-email module. It POSTs directly to the Resend REST API — no SDK dep. **Every exported function returns `Promise<void>` and NEVER throws.** Email is a best-effort side channel; a failed send must not break submit or review. Failures log with the address redacted.

If `RESEND_API_KEY` is unset, every function logs once at module load and no-ops. Local dev works without a key.

Trigger points (all fire-and-forget):
- `sendSubmissionReceived` — on `/submit` if email given.
- `sendReviewerMessage` — when staff post a chat message.
- `sendDecision` — on approve or reject.
- `sendLookupDigest` — when someone uses `/lookup`.

## Routes (high level)

| Method | Path                                | Handler |
|--------|-------------------------------------|---------|
| GET    | `/`                                 | `routes/home.ts` (intro + count + CTA, then `renderBrowseBody` — home *is* browse from the search box down) |
| GET    | `/about`                            | `routes/about.ts` |
| GET    | `/privacy`                          | `routes/privacy.ts` |
| GET    | `/browse`                           | `routes/browse.ts` (filters: category, tag, model, status, q; sort: new/old/verified/id). Listing is an indented list (incl. prompt/output) via shared `renderBrowseBody`; `q` that names a category (`resolveCategory`) becomes a category filter. |
| GET    | `/e/:public_id`                     | `routes/entry.ts` (accepts A-number OR legacy slug; legacy 301→canonical) |
| GET    | `/submit`                           | `routes/submit.ts` |
| POST   | `/submit`                           | `routes/submit.ts` |
| GET    | `/my/submissions`                   | `routes/my.ts` (submitter dashboard; list, A-number → overview) |
| GET    | `/my/submissions/:eahId`            | `routes/my.ts` (`myView`; read-only overview: info + discussion + history) |
| GET    | `/my/submissions/:eahId/edit`       | `routes/my.ts` (non-editable statuses 303→overview) |
| POST   | `/my/submissions/:eahId/edit`       | `routes/my.ts` (save draft) |
| POST   | `/my/submissions/:eahId/propose`    | `routes/my.ts` (draft → pending; pending-cap re-checked) |
| GET    | `/my/submissions/:eahId/withdraw`   | `routes/my.ts` (withdraw confirm page) |
| POST   | `/my/submissions/:eahId/withdraw`   | `routes/my.ts` (pending → draft; keeps discussion + A-number) |
| GET    | `/my/submissions/:eahId/delete`     | `routes/my.ts` (delete confirm page) |
| POST   | `/my/submissions/:eahId/delete`     | `routes/my.ts` (draft-only hard delete; recycles A-number) |
| GET    | `/my/submissions/:eahId/history`    | `routes/my.ts` (version diffs) |
| GET    | `/my/submissions/:eahId/discussion` | `routes/my-discussion.ts` |
| POST   | `/my/submissions/:eahId/message`    | `routes/my-discussion.ts` |
| GET    | `/api/username-check`               | `routes/api.ts` |
| GET    | `/rss`                              | `routes/rss.ts` |
| GET    | `/sitemap.xml`                      | `routes/sitemap.ts` |
| GET    | `/login`                            | `routes/login.ts` |
| POST   | `/login`                            | `routes/login.ts` |
| POST   | `/logout`                           | `routes/login.ts` |
| GET    | `/signup`                           | `routes/signup.ts` |
| POST   | `/signup`                           | `routes/signup.ts` |
| GET    | `/verify`                           | `routes/verify.ts` |
| POST   | `/verify`                           | `routes/verify.ts` |
| POST   | `/verify/resend`                    | `routes/verify.ts` |
| POST   | `/oauth/google/verify`              | `routes/oauth-google-routes.ts` (GIS ID-token verify) |
| GET    | `/admin/queue`                      | `routes/admin/queue.ts` |
| GET    | `/admin/queue/:id`                  | `routes/admin/queue.ts` (detail + chat) |
| POST   | `/admin/queue/:id`                  | `routes/admin/review.ts` (approve/reject) |
| POST   | `/admin/queue/:id/message`          | `routes/admin/review.ts` (staff chat msg) |
| GET    | `/admin/all`                        | `routes/admin/all.ts` (read-only triage list; **no bulk actions** — every decision must carry a reviewer message, so acting on a row means clicking through to `/admin/queue/:id`) |
| GET    | `/admin/all/:id/delete`             | `routes/admin/all.ts` (owner-only delete confirm) |
| POST   | `/admin/all/:id/delete`             | `routes/admin/all.ts` (owner-only permanent delete; retires A-number) |
| GET    | `/admin/users`                      | `routes/admin/users.ts` (staff: read-only; owner: actions) |
| GET    | `/admin/staff`                      | `routes/admin/users.ts` (privileged roster) |
| POST   | `/admin/users/:id`                  | `routes/admin/users.ts` (owner-only; action field) |
| GET    | `/admin/entries/new`                | `routes/admin/entries.ts` (direct-add) |
| POST   | `/admin/entries/new`                | `routes/admin/entries.ts` |
| GET    | `/admin/entries/:eahId/edit`        | `routes/admin/entries.ts` |
| POST   | `/admin/entries/:eahId/edit`        | `routes/admin/entries.ts` |
| POST   | `/admin/entries/:eahId/status`      | `routes/admin/entries.ts` (Active↔Patched) |

## Deploy

Compose file uses `network_mode: host` so the container reaches MariaDB on `127.0.0.1` and the Bun server binds `127.0.0.1:8090` (cloudflared on the same host is the only public path). The canonical deploy is now `./deploy.sh` (checked in). To deploy after changes:

```sh
./deploy.sh   # rsync working tree → host, then `docker compose up -d --build` + migrate
```

**The current host is the SSH alias `randy` (a temporary box — Pi/homelab). Don't hardcode `randy` anywhere in source; `deploy.sh` is the one place it lives, so retargeting is a one-line edit there.** The public URL is `https://eah.warrenwoolf.com`, fronted by Cloudflare → cloudflared → `127.0.0.1:8090`.

⚠️ **Cloudflare caches `/static/*` aggressively (edge TTL set to 4h via a zone rule, longer than the `max-age=3600` we send).** After deploying a change to a static asset (`style.css`, `theme.js`, `google.js`), the new file is live *in the container* immediately but the public URL keeps serving the stale edge copy — and `Ctrl+Shift+R` only busts the *browser* cache, not Cloudflare's. **You must purge the Cloudflare cache** (dashboard → Caching → Purge, or the API) for static changes to appear. TypeScript/server changes are unaffected (never cached). Symptom to recognize: `curl -sI <url> | grep cf-cache-status` shows `HIT` with an old `last-modified`. There is deliberately no asset cache-buster — the owners prefer to purge manually.

`migrate.ts` is idempotent and additive (per the policy below). `seed-admin.ts` is idempotent (upserts the named admin into `users`).

`scripts/drop-legacy.ts` is the one-shot destructive migration that retired the old `admins` / `admin_sessions` / `email_sends` tables and renamed `submission_messages.sender_admin_id` → `sender_user_id`. It's idempotent — re-running prints "nothing to do" — and should be run once after the accounts deploy. If any admin had a bcrypt password hash, it's NULLed by this script; re-run `seed-admin.ts` to restore it as argon2id.

The deployment target may move at some point (it's currently `randy`, a temporary box) — keep the deploy commands flexible. Don't bake hostnames or absolute paths into source code; read from env where possible.

## Testing

- `bun test` runs the unit suite against a **mocked `src/db.ts`** (no MariaDB). `EAH_TEST_DB=1 bun test test/integration/` spins up a throwaway MariaDB in Docker (see `test/setup.ts`).
- **`mock.module` bleeds across test files.** Bun resolves every test file's static imports before any `beforeAll` runs, and `mock.module` installs a *live binding* that updates already-imported references process-wide. So if file A mocks a widely-imported module (`src/config.ts`, `src/db.ts`), file B's `import { config }` sees the mock too — even across files. Two consequences worth remembering:
  - When you mock such a module, save the real one first and restore it in `afterAll` (the `handlers.test.ts` db-mock and `oauth-google.test.ts` config-mock both do this).
  - Don't write assertions in one file that depend on the *default value* of something another file mocks (e.g. `config.googleOAuth.clientId === ""`). Assert the **shape**, not the value, or the test is order-dependent and flaky. This bit during the JWKS migration: `oauth-google.test.ts` mocks `config` to give `clientId` a value, which broke a value-assertion in `config.test.ts`.

## House style

- **Restrained and OEIS-influenced, but modernizing — no longer strictly "spare."** The baseline is still serif body, plain forms, and simple tables, and the *motion* rules are unchanged: **no transitions, no animations, no hover-scale, no JS-driven visual effects.** What has been relaxed is the old "no fancy CSS" absolutism: the site is now full-bleed with a richer browse layout and styled entry-cards, and modern static CSS is welcome where it earns its keep. Specifically, the following are deliberate and **should not be "simplified" back out**:
  - **Typography.** The body base size is a flat `17px` (set in both the base `body` rule and the ≤600px breakpoint). Everything else is sized in `em`, so changing that one value rescales the whole site. The **site title** (`.site-title-text`) and **credit** (`.site-credit`) use rem-based `clamp()`s so they scale fluidly with viewport width and never overflow tiny phones — these replaced the old per-breakpoint `font-size` overrides, so the ≤600px / ≤400px media queries now carry only *structural* rules (wrap, stack, logo sizing) plus a single co-qualified `.site-header-top .site-credit` margin override. (NB: the base `body` size was briefly a `clamp()` during the redesign but was reverted to flat 17px — don't reintroduce a fluid body size without a reason.)
  - **Full-bleed two-column browse.** `.browse-layout` is `grid-template-columns: 240px 1fr` — a sticky filter sidebar plus an entry list that runs to the right edge. (It used to be `240px 1fr 240px` with an empty right track to center the list; that track was removed on purpose — don't re-add it.)
  - **Rounded, colored entry-cards** (`.entry-card` / `.entry-card-head`) shared across browse/home/dashboard/entry. The card-header blue is `--entry-head-bg` (currently `#0a3367`).
  - **Top bar (`.site-nav` in `layout.ts`).** Primary links (Browse/Submit/Guide/About/Terms) are **plain capitalized black labels**, NOT blue hyperlinks (`.site-nav .nav-links a { color: var(--text) }`) — the prominent blue is reserved for account actions. **Log in / Sign up / Log out** are filled blue buttons (`.btn-prominent`, same `--entry-head-bg` as the cards), used as both `<a>` and `<button>`. Account/admin links (My drafts, Queue, All, Users, Staff) live in a **CSS-only hover/`:focus-within` dropdown** (`.account-menu` → `.account-trigger` + `.account-dropdown`) under the "Signed in as: X" trigger; on ≤700px the dropdown renders inline (static, always-open) since there's no hover on touch. The **theme toggle stays deliberately small and unobtrusive** (`.theme-toggle`, muted text, no background) — don't promote it to a button.
  - Still off-limits: animation/transitions, client-side JS beyond `theme.js`, and CSS frameworks. The account dropdown is intentionally **pure CSS** (`:hover`/`:focus-within`), not JS. Reach for plain modern CSS, not a toolkit.
- **Shared listing UI: the entry-card.** The browse listing, the home page, and the `/my/submissions` dashboard all render submissions as the same `.entry-card` component — a collapsible `<details>` with a colored `.entry-card-head` summary, an `.entry-info` grid, and `.entry-field-box` prompt/response boxes. The long-text clamp helper `longField()` is **exported from `src/routes/browse.ts`** and reused by `my.ts`; the entry page (`/e/:id`) reuses `.entry-card-head` too. So a change to the card markup or its CSS (§8j) ripples across browse/home/dashboard/entry — grep `entry-card` before editing. Convention: the **Entry ID is the first row** of the info grid (it's the permalink — leading with it signals "click here").
- **CSS gotcha — equal specificity resolves by source order.** `.entry-card-head` (defined late, in §8j) sets `cursor: pointer` for the collapse toggle. The single-entry page's title bar carries *both* `.entry-card-head` and `.entry-page-head`, so an earlier `.entry-page-head { cursor: default }` (same specificity, defined earlier) loses and the static bar wrongly shows a clickable cursor. Fix is to **co-qualify both classes** (`.entry-card-head.entry-page-head { … }`) to raise specificity rather than relying on order. Watch for this whenever a `.entry-card-head` element is *not* a real toggle.
- **All HTML through `h\`\``.** Reviewing your diff? Search for `+` lines containing `<` and make sure they're inside `h\`\``.
- **Dates:** display as `YYYY-MM-DD` (UTC) on user pages, `YYYY-MM-DD HH:MM:SS UTC` on admin pages.
- **Tone of staff-facing copy:** terse, lowercase headings ("queue", "pending", "review"), explanatory captions next to fields. User-facing copy is sentence-case prose.
- **Comments:** explain *why*, not *what*. Tradeoffs deserve a paragraph; obvious code doesn't need a comment.

## Things to NOT do

- Don't add a "jailbreak" category. Compiling working jailbreaks has obvious downsides.
- Don't bypass `h\`\`` for HTML — that's the XSS chokepoint.
- (Historical note: this file used to say "don't add user accounts." That's obsolete — accounts now exist and submission is account-only. Don't *remove* the account system without a deliberate decision.)
- Don't drop columns in `scripts/migrate.ts`. Add via `ALTER TABLE … IF NOT EXISTS`. Destructive changes go in a separate script.
- Don't store raw IPs.
- Don't write client-side JS frameworks. The theme toggle is the only JS, and it's deliberate.
- Don't push to `main` without testing locally (`bunx tsc --noEmit` at minimum; ideally boot the server and hit a few routes).
