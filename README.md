# Encyclopedia of AI Hallucinations (EAH)

A community-submitted, staff-reviewed catalog of LLM hallucinations — the prompt, the model's output, and what kind of hallucination it is. Inspired by OEIS in spirit: A-number-style permanent IDs (`A000001`, …), draft queue with reviewer↔submitter chat, deliberately plain server-rendered HTML.

**Status: in development.** Schema and URLs may still change; see the banner at the top of every page.

Founded in 2026 by Rudra Jadhav and Warren Woolf.

## Stack

- Bun + TypeScript, server-rendered HTML. No SPA, no client framework. One small vanilla-JS file for the theme toggle.
- MariaDB.
- Docker for deployment.
- Cloudflared tunnel for ingress.
- Resend (free tier) for transactional email — optional, the site works without it.

## Local dev

```sh
bun install
cp .env.example .env       # fill in DB creds + SESSION_SECRET (and Resend key if you want email)
bun run migrate            # idempotent — safe to re-run; backfills A-numbers on existing rows
ADMIN_BOOTSTRAP_USER=root ADMIN_BOOTSTRAP_PASS=hunter2-or-better bun run seed-admin
bun run dev
```

Visit http://localhost:8090.

## Deploy

Production runs in Docker behind a Cloudflared tunnel. From a workstation with an `eah` SSH alias for the host:

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

The compose file uses `network_mode: host` so the container reaches MariaDB on `127.0.0.1` and the Bun server binds `127.0.0.1:8090` (cloudflared is the only public path). `scripts/migrate.ts` is idempotent — re-running it is the canonical "apply latest schema changes" step.

## Entry model

Every accepted entry has these fields. `submissions.eah_number` is the underlying integer; the public display is `formatEahId(n)` → `A000123`.

| Field                  | Required | Notes |
|------------------------|----------|-------|
| EAH ID (`A######`)     | auto     | Allocated at draft creation. Freed back into `freed_eah_numbers` on reject/withdraw. Locked once published. |
| Title                  | yes      | Short descriptive name. |
| Prompt                 | yes      | Verbatim. |
| Output                 | yes      | Verbatim. |
| AI model               | yes      | Free-text; format like `GPT-4o`, `Claude 3.5 Sonnet`, or `Google AI Overview (accessed 2026-05-19)`. |
| Category               | yes      | Fixed list in `src/categories.ts`. |
| Tags                   | optional | Comma-separated, lowercase `[a-z0-9-]`, max 10. |
| Summary                | optional | One-line description of what's wrong. |
| Notes                  | optional | Repro steps, model version, system prompt, etc. |
| Date of hallucination  | optional | `YYYY-MM-DD`. Defaults to submission date if blank. |
| Shared chat URL        | optional | Public on the entry page. |
| Author name            | optional | Public if set. |
| Submitter email        | optional | Never public. Enables email notifications + `/lookup`. |
| Allow author edits     | optional | Submitter opt-in for post-publication author edits. |
| Entry status           | auto     | `active` (still reproduces) or `patched` (model updated, no longer triggers). Staff-controlled. |
| Verification           | staff    | "Prompt reproduced N out of M times when staff tried it." |

## Submission & review workflow

1. Anyone can submit at `/submit`. No account required.
2. On submit, the row is inserted as `pending`, an A-number is allocated, and a 24-char tracking code is generated. The submitter sees the code once (and gets it by email if they provided one).
3. If the submitter gave an email, **at most 4 drafts can be pending per email** at any time. Once one is accepted/rejected/withdrawn, a slot opens up.
4. The submitter visits `/track?code=…` (or `/draft/:token`) to: see status, chat with reviewers, withdraw.
5. Staff log in at `/admin/login`, work through the queue at `/admin/queue`, and on `/admin/queue/:id` can post chat messages (emails the submitter), approve, or reject.
6. **On approve:** status flips to `published`; A-number locked permanently; submitter emailed.
7. **On reject or withdraw:** A-number is returned to `freed_eah_numbers` and reused for the next incoming draft. Atomic with the status flip.
8. Staff can add entries directly (bypassing the draft queue) at `/admin/entries/new`, edit any entry at `/admin/entries/A######/edit`, and flip Active↔Patched at `/admin/entries/A######/status`.

## Layout

```
src/
  server.ts         Bun.serve entrypoint + route table + CSP / security headers
  config.ts         env parsing
  db.ts             MariaDB pool, query/execute/transaction helpers
  html.ts           escape() + h tagged template (XSS-safe interpolation)
  layout.ts         base HTML shell (header, banner, footer, theme toggle, admin nav)
  csrf.ts           HMAC double-submit CSRF tokens
  auth.ts           bcrypt + session cookies
  ratelimit.ts      in-memory token bucket per IP
  categories.ts     fixed category list
  email.ts          Resend client + transactional email bodies
  eah-id.ts         A-number allocation, freeing, formatting, parsing
  routes/
    home.ts entry.ts browse.ts submit.ts track.ts about.ts privacy.ts lookup.ts types.ts
    admin/
      login.ts queue.ts review.ts all.ts entries.ts
  static/
    style.css   robots.txt   theme.js
scripts/
  migrate.ts        idempotent schema bootstrap + A-number backfill
  seed-admin.ts     create first admin from env
```

## Categories

Fixed list in `src/categories.ts`. Free-form tags live in the `tags` / `submission_tags` join.

## Email

Outbound email uses Resend (free tier: 3000/month, 100/day). When `RESEND_API_KEY` is unset, all email functions no-op cleanly — the site keeps working without it. Trigger points:

- `sendSubmissionReceived` — on `/submit` if the submitter gave an email.
- `sendReviewerMessage` — when staff post a chat message on a pending draft.
- `sendDecision` — on accept or reject.
- `sendLookupDigest` — when someone enters their email at `/lookup`.

## Theme

Dark/light/auto toggle in the header nav. `auto` (default) follows `prefers-color-scheme`; `light` and `dark` force the override and persist in `localStorage["eah-theme"]`. `src/static/theme.js` reads the preference synchronously in `<head>` (no FOUC). CSP allows `script-src 'self'` for this one script.
