# CLAUDE.md — orientation for future Claudes

You're working on the **Encyclopedia of AI Hallucinations (EAH)**: an OEIS-inspired, community-submitted, staff-reviewed catalog of LLM hallucinations. Read README.md for the user-facing story. This file is the "what you actually need to know to make changes safely" file.

Co-founders: **Rudra Jadhav** and **Warren Woolf** (`Interrobang` / `warrenwoolf` on GitHub). The site footer credit and About page reflect this.

## Stack and conventions

- **Bun + TypeScript.** No build step. `bun run dev` (hot reload) or `bun src/server.ts`. Type-check with `bunx tsc --noEmit`.
- **Server-rendered HTML.** No client framework. One small vanilla-JS file (`src/static/theme.js`) for the dark-mode toggle. Don't add more client JS without a real reason — the house style is deliberately plain.
- **MariaDB** via the `mariadb` npm driver. Everything goes through `src/db.ts` (`query`, `queryOne`, `execute`, `transaction`). Always pass user values as `?` parameters; never interpolate into SQL.
- **HTML rendering is XSS-safe via `h\`...\``** in `src/html.ts`. ALL HTML output goes through `h\`\`` or `raw()`. `raw()` is for constants you fully control — never on user input. Do not concatenate user strings into HTML, ever.
- **CSRF:** HMAC-signed double-submit cookie + hidden field. Every form must include `<input type="hidden" name="_csrf" value="${csrfToken}">` and the handler must call `verifyCsrf(req, form.get("_csrf"))` before doing anything mutating.
- **Rate-limiting:** in-memory token bucket per IP in `src/ratelimit.ts`. Buckets: `submit`, `login`, `signup`, `verify`, `oauth`, `withdraw`, `lookup`. Add a new bucket entry if you add a new POST that hits external services or writes to the DB on behalf of anonymous users.
- **Sessions:** all users (admins are users with `is_admin=1`). Cookie holds a random token; DB stores only its sha256. Logic in `src/auth.ts`.

## Security model — do not weaken

- **CSP:** strict. `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'`. `script-src 'self'` exists for the theme toggle only. Don't relax to `'unsafe-inline'` without a very good reason.
- **No raw IPs stored.** `ip_hash` is `sha256(SESSION_SECRET || ip)`. The Cloudflare `cf-connecting-ip` header is honored ONLY when the immediate TCP peer is loopback (cloudflared on the same host). Never trust `X-Forwarded-For`.
- **Tracking codes** are 24-char base64url. Only the sha256 is stored in `submissions.tracking_hash`. The plaintext is additionally stored in `submissions.notify_token` BUT ONLY when the submitter gave an email (so `/lookup` can rebuild tracking links). Submissions without an email keep the hash-only model.
- **Trojan-source / control-char scrub:** all user text passes through `sanitizeText()` in `src/routes/types.ts` before storage. Strips C0/C1 controls (except tab/LF/CR), BiDi overrides, zero-width chars, BOM.
- `multipleStatements: false` on the DB pool.

## The A-number system (most distinctive piece)

Every submission has `submissions.eah_number` (nullable INT). Displayed everywhere as `A` + 6-digit zero-padded → `A000001`. Helpers in `src/eah-id.ts`:

- `allocateEahNumber(tx)` — pops MIN from `freed_eah_numbers` if any, else uses `MAX(eah_number) + 1`. **Must be called inside the same transaction that inserts the row claiming the number**, otherwise it leaks on contention.
- `freeEahNumber(tx, submissionId)` — sets `eah_number = NULL` on the row and inserts the integer into `freed_eah_numbers`. Called on **reject** and on **withdraw**. Must be in the same transaction as the status flip — never expose a `rejected`-with-live-A-number state to readers.
- `formatEahId(n)` / `parseEahId(s)` — format/parse the `A######` string.

Allocation rules (matches OEIS):
- Allocated at **draft creation** (submit time).
- Freed on **reject** and **withdraw**.
- Locked permanently on **publish**.

The migration's `backfillEahNumbers()` step assigns numbers to existing `pending`/`published` rows in (`submitted_at`, `id`) order. It deliberately skips `rejected`/`withdrawn` rows so they don't consume numbers in the new scheme.

Legacy `submissions.public_id` (random 10-char base64url) is still generated for new rows for back-compat with any URL that was shared while the old scheme was live. `GET /e/:id` accepts either an A-number or a legacy public_id; the legacy path 301-redirects to the canonical `A######` URL.

## Accounts

Single `users` table — admins are just `is_admin=1` rows. There is no separate admins table (it was dropped via `scripts/drop-legacy.ts`).

Auth model:

- **Passwords:** argon2id via `Bun.password.hash` / `Bun.password.verify`. **No bcrypt** — verification of any non-argon2 hash returns false. If you find yourself needing to import bcryptjs, stop and add a password-reset flow instead.
- **Google OAuth:** `arctic` (`src/oauth-google.ts`). State + PKCE verifier persisted in a 10-minute HMAC-signed HttpOnly cookie scoped to `/oauth/google/callback` — no DB table. `email_verified` claim must be true; sub is stored in `users.google_sub`. Linking policy: if Google email matches an existing verified password account, attach `google_sub` to that account.
- **Email verification:** 6-digit code, 15-minute TTL, 5-attempt cap, in `email_verifications`. Codes are sha256-hashed in the DB; `consumeVerificationCode` does the timing-safe compare and the attempt-counter bookkeeping inside a transaction.
- **Pending-verify cookie:** `eah_pending_verify` is an HMAC-signed cookie carrying `userId` that scopes to `/verify` only. Issued by `/signup` and `/login` when the target user is unverified. `/verify` reads it — sessions are NOT created until verification succeeds.
- **Enumeration resistance:** `/signup` and `/verify/resend` MUST return the same response shape regardless of whether the email is already in use. The /signup POST always redirects to `/verify` with a pending-verify cookie (pointing at the existing user if any, or the newly-created one). Username collisions DO leak — usernames are public and the user needs to know to pick another.

### Resend monthly cap

Free tier is 300 sends/month. We read Resend's `x-resend-monthly-quota` response header after every API call and cache it in `src/email.ts`. `emailCapReached()` returns true when the cached value is ≥ `EMAIL_MONTHLY_CAP` (default 280; set 0 to disable). On cold start `primeQuotaCache()` does a best-effort `GET /domains` to seed the cache; if Resend is unreachable the gate fails open. If we're at cap, `/signup` hides the password form (Google is still offered) and returns 503 when both are unavailable.

### Bootstrap admin

`scripts/seed-admin.ts` upserts a single admin row from `ADMIN_BOOTSTRAP_{USER,EMAIL,PASS}`. It writes only to `users`. Re-running with new values updates the existing row.

## Submission & review flow

- `/submit` enforces: 4-pending-drafts cap per email (only if email provided), required fields, all length caps, valid category, tag format `^[a-z0-9-]+$`, date parsing, URL validation.
- `/track?code=…` and `/draft/:token` are the same view — submitter's draft page with chat thread, withdraw button, status. The submitter can post into the chat thread while the submission is `pending`; locked when decided.
- `/admin/queue` and `/admin/queue/:id` — staff queue + detail with chat thread. `POST /admin/queue/:id` approves/rejects (and on reject, frees the A-number in the same tx). `POST /admin/queue/:id/message` posts a staff chat message and emails the submitter via `sendReviewerMessage`.
- `/admin/entries/new`, `/admin/entries/:eahId/edit`, `/admin/entries/:eahId/status` — direct staff actions, bypass the draft queue.
- `submission_messages` table holds the chat. `sender_type` is `staff` / `user` / `system`. `system` rows are auto-posted on accept/reject/withdraw.

## Database schema

`scripts/migrate.ts` is the **only** source of schema truth and is **idempotent + additive**. Adding a column? Add an entry to `COLUMN_ADDITIONS` with `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`. Don't write one-off migration files; don't drop columns in this script. If you need to drop something, write a separate destructive script and run it manually with eyes open.

Key columns on `submissions`:

- `id` (PK), `public_id` (legacy slug), `eah_number` (the A-number), `title`, `tracking_hash` (BINARY(32)), `notify_token` (plaintext code, only set if email given), `submitter_email`.
- `prompt`, `output`, `ai_model`, `summary`, `notes`, `shared_chat_url`, `category`, `author_name`, `hallucination_date`, `allow_author_edits`.
- `entry_status` ENUM('active','patched') — distinct from moderation `status` ENUM('pending','published','rejected','withdrawn').
- `verified_hits` / `verified_total` — "prompt reproduced N/M times when staff tried it."
- `reviewed_by`, `reviewed_at`, `reviewer_notes` (private), `rejection_reason` (shown to submitter), `staff_review_message` (shown to submitter, included in decision email).
- `ip_hash` (BINARY(32)).

Other tables: `users` + `user_sessions` (account auth), `email_verifications` (signup codes), `tags` + `submission_tags` join, `submission_messages` (chat; `sender_user_id` FKs `users(id)`), `freed_eah_numbers` (A-number pool).

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
| GET    | `/`                                 | `routes/home.ts` |
| GET    | `/about`                            | `routes/about.ts` |
| GET    | `/privacy`                          | `routes/privacy.ts` |
| GET    | `/browse`                           | `routes/browse.ts` (filters: category, tag, model, status, q; sort: new/old/verified/id) |
| GET    | `/e/:public_id`                     | `routes/entry.ts` (accepts A-number OR legacy slug; legacy 301→canonical) |
| GET    | `/submit`                           | `routes/submit.ts` |
| POST   | `/submit`                           | `routes/submit.ts` |
| GET    | `/track[?code=…]`                   | `routes/track.ts` (submitter draft view) |
| POST   | `/track/withdraw`                   | `routes/track.ts` (frees A-number) |
| POST   | `/track/message`                    | `routes/track.ts` (submitter posts chat msg) |
| GET    | `/draft/:token`                     | `routes/track.ts` (same view, friendlier URL) |
| GET    | `/lookup`                           | `routes/lookup.ts` |
| POST   | `/lookup`                           | `routes/lookup.ts` (email digest) |
| GET    | `/login`                            | `routes/login.ts` |
| POST   | `/login`                            | `routes/login.ts` |
| POST   | `/logout`                           | `routes/login.ts` |
| GET    | `/signup`                           | `routes/signup.ts` |
| POST   | `/signup`                           | `routes/signup.ts` |
| GET    | `/verify`                           | `routes/verify.ts` |
| POST   | `/verify`                           | `routes/verify.ts` |
| POST   | `/verify/resend`                    | `routes/verify.ts` |
| POST   | `/oauth/google/start`               | `routes/oauth-google-routes.ts` |
| GET    | `/oauth/google/callback`            | `routes/oauth-google-routes.ts` |
| GET    | `/admin/queue`                      | `routes/admin/queue.ts` |
| GET    | `/admin/queue/:id`                  | `routes/admin/queue.ts` (detail + chat) |
| POST   | `/admin/queue/:id`                  | `routes/admin/review.ts` (approve/reject) |
| POST   | `/admin/queue/:id/message`          | `routes/admin/review.ts` (staff chat msg) |
| GET    | `/admin/all`                        | `routes/admin/all.ts` |
| GET    | `/admin/entries/new`                | `routes/admin/entries.ts` (direct-add) |
| POST   | `/admin/entries/new`                | `routes/admin/entries.ts` |
| GET    | `/admin/entries/:eahId/edit`        | `routes/admin/entries.ts` |
| POST   | `/admin/entries/:eahId/edit`        | `routes/admin/entries.ts` |
| POST   | `/admin/entries/:eahId/status`      | `routes/admin/entries.ts` (Active↔Patched) |

## Deploy

Compose file uses `network_mode: host` so the container reaches MariaDB on `127.0.0.1` and the Bun server binds `127.0.0.1:8090` (cloudflared on the same host is the only public path). To deploy after changes:

```sh
rsync -avz --delete \
  --exclude .git --exclude node_modules --exclude .env \
  ./ eah:~/eah/
ssh eah '
  cd ~/eah \
  && docker compose up -d --build \
  && docker compose exec eah bun scripts/migrate.ts
'
```

`migrate.ts` is idempotent and additive (per the policy below). `seed-admin.ts` is idempotent (upserts the named admin into `users`).

`scripts/drop-legacy.ts` is the one-shot destructive migration that retired the old `admins` / `admin_sessions` / `email_sends` tables and renamed `submission_messages.sender_admin_id` → `sender_user_id`. It's idempotent — re-running prints "nothing to do" — and should be run once after the accounts deploy. If any admin had a bcrypt password hash, it's NULLed by this script; re-run `seed-admin.ts` to restore it as argon2id.

The deployment target may move at some point — keep the deploy commands flexible (an `eah` SSH alias, a generic `~/eah` path). Don't bake hostnames or absolute paths into source code; read from env where possible.

## House style

- **No hover effects, no animations, no fancy CSS.** OEIS-flavored: serif body, plain forms, simple tables.
- **All HTML through `h\`\``.** Reviewing your diff? Search for `+` lines containing `<` and make sure they're inside `h\`\``.
- **Dates:** display as `YYYY-MM-DD` (UTC) on user pages, `YYYY-MM-DD HH:MM:SS UTC` on admin pages.
- **Tone of staff-facing copy:** terse, lowercase headings ("queue", "pending", "review"), explanatory captions next to fields. User-facing copy is sentence-case prose.
- **Comments:** explain *why*, not *what*. Tradeoffs deserve a paragraph; obvious code doesn't need a comment.

## Things to NOT do

- Don't add a "jailbreak" category. Compiling working jailbreaks has obvious downsides.
- Don't bypass `h\`\`` for HTML — that's the XSS chokepoint.
- Don't add user accounts / OAuth. The model is intentionally email-tracking-token only for submitters; admin login is username+password.
- Don't drop columns in `scripts/migrate.ts`. Add via `ALTER TABLE … IF NOT EXISTS`. Destructive changes go in a separate script.
- Don't store raw IPs.
- Don't write client-side JS frameworks. The theme toggle is the only JS, and it's deliberate.
- Don't push to `main` without testing locally (`bunx tsc --noEmit` at minimum; ideally boot the server and hit a few routes).
