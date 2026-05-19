# Encyclopedia of AI Hallucinations (EAH)

A community-submitted catalog of LLM hallucinations: the prompt, the model's output, and what kind of hallucination it is. Inspired by OEIS.

**Status: in development.** No public links yet.

## Stack

- Bun + TypeScript, server-rendered HTML (no SPA, no build step for pages)
- MariaDB
- Docker for deployment
- Cloudflared tunnel for ingress

## Local dev

```sh
bun install
cp .env.example .env       # fill in DB creds + SESSION_SECRET
bun run migrate            # create tables
ADMIN_BOOTSTRAP_USER=root ADMIN_BOOTSTRAP_PASS=hunter2 bun run seed-admin
bun run dev
```

Visit http://localhost:8090.

## Deploy

See `/home/interrobang/.claude/plans/hi-claude-me-and-gentle-tower.md` for the deployment plan.

## Layout

```
src/
  server.ts         Bun.serve entrypoint and route table
  db.ts             MariaDB pool, prepared-statement helpers
  config.ts         env parsing
  html.ts           escape() + h tagged template (XSS-safe interpolation)
  layout.ts         base HTML layout
  csrf.ts           per-session CSRF tokens
  ratelimit.ts      in-memory token bucket per IP
  auth.ts           bcrypt + session cookies
  categories.ts     fixed category list
  routes/           one file per page
scripts/
  migrate.ts        idempotent schema bootstrap
  seed-admin.ts     create first admin from env
```

## Categories

Fixed list lives in `src/categories.ts`. Free-form tags are a separate table.
