# Route table

| Method | Path | Handler |
|--------|------|---------|
| GET | `/` | `routes/home.ts` (intro + count + CTA, then `renderBrowseBody` — home *is* browse from the search box down) |
| GET | `/about` | `routes/about.ts` |
| GET | `/privacy` | `routes/privacy.ts` |
| GET | `/contact` | `routes/contact.ts` |
| GET | `/browse` | `routes/browse.ts` (filters: category, tag, model, status, q; sort: new/old/verified/id). Categories are multi-select (`?category=a&category=b`). Sidebar shows faceted counts. `browse.js` swaps `#browse-root` without a full reload. |
| GET | `/e/:public_id` | `routes/entry.ts` (accepts A-number OR legacy slug; legacy 301→canonical) |
| POST | `/e/:public_id/complaint` | `routes/complaint.ts` (reader complaint; public + anon; → `/e/:id?complaint=ok`) |
| GET | `/submit` | `routes/submit.ts` |
| POST | `/submit` | `routes/submit.ts` |
| GET | `/my/submissions` | `routes/my.ts` (submitter dashboard) |
| GET | `/my/submissions/:eahId` | `routes/my.ts` (`myView` — read-only overview: info + discussion + history) |
| GET | `/my/submissions/:eahId/edit` | `routes/my.ts` (non-editable statuses 303→overview) |
| POST | `/my/submissions/:eahId/edit` | `routes/my.ts` |
| POST | `/my/submissions/:eahId/propose` | `routes/my.ts` (draft → pending; pending-cap re-checked) |
| GET | `/my/submissions/:eahId/withdraw` | `routes/my.ts` (confirm page) |
| POST | `/my/submissions/:eahId/withdraw` | `routes/my.ts` (pending → draft; keeps discussion + A-number) |
| GET | `/my/submissions/:eahId/delete` | `routes/my.ts` (confirm page) |
| POST | `/my/submissions/:eahId/delete` | `routes/my.ts` (draft-only hard delete; recycles A-number) |
| GET | `/my/submissions/:eahId/history` | `routes/my.ts` (version diffs) |
| GET | `/my/submissions/:eahId/discussion` | `routes/my-discussion.ts` |
| POST | `/my/submissions/:eahId/message` | `routes/my-discussion.ts` |
| GET | `/api/username-check` | `routes/api.ts` |
| GET | `/rss` | `routes/rss.ts` |
| GET | `/sitemap.xml` | `routes/sitemap.ts` |
| GET | `/login` | `routes/login.ts` |
| POST | `/login` | `routes/login.ts` |
| POST | `/logout` | `routes/login.ts` |
| GET | `/signup` | `routes/signup.ts` |
| POST | `/signup` | `routes/signup.ts` |
| GET | `/verify` | `routes/verify.ts` |
| POST | `/verify` | `routes/verify.ts` |
| POST | `/verify/resend` | `routes/verify.ts` |
| POST | `/oauth/google/verify` | `routes/oauth-google-routes.ts` (GIS ID-token verify) |
| GET | `/admin/queue` | `routes/admin/queue.ts` |
| GET | `/admin/queue/:id` | `routes/admin/queue.ts` (detail + chat) |
| POST | `/admin/queue/:id` | `routes/admin/review.ts` (approve/reject) |
| POST | `/admin/queue/:id/message` | `routes/admin/review.ts` (staff chat msg) |
| GET | `/admin/all` | `routes/admin/all.ts` (read-only triage list; no bulk actions — click through to `/admin/queue/:id` to act) |
| GET | `/admin/complaints` | `routes/admin/complaints.ts` (open reader complaints; gated on `ctx.admin`) |
| GET | `/admin/all/:id/delete` | `routes/admin/all.ts` (owner-only confirm) |
| POST | `/admin/all/:id/delete` | `routes/admin/all.ts` (owner-only permanent delete; retires A-number) |
| GET | `/admin/users` | `routes/admin/users.ts` (staff: read-only; owner: actions) |
| GET | `/admin/staff` | `routes/admin/users.ts` (privileged roster) |
| POST | `/admin/users/:id` | `routes/admin/users.ts` (owner-only; action field) |
| GET | `/admin/entries/new` | `routes/admin/entries.ts` (direct-add) |
| POST | `/admin/entries/new` | `routes/admin/entries.ts` |
| GET | `/admin/entries/:eahId/edit` | `routes/admin/entries.ts` |
| POST | `/admin/entries/:eahId/edit` | `routes/admin/entries.ts` |
| POST | `/admin/entries/:eahId/status` | `routes/admin/entries.ts` (Active↔Patched) |
