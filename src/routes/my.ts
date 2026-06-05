/**
 * User dashboard and draft management.
 *
 *   GET  /my/submissions                      — list all user's submissions
 *   GET  /my/submissions/:eahId/edit          — view or edit a submission
 *   POST /my/submissions/:eahId/edit          — save edits (keeps status='draft')
 *   POST /my/submissions/:eahId/propose       — flip status to 'pending'
 *   POST /my/submissions/:eahId/withdraw      — flip to 'withdrawn', free A-number
 *   GET  /my/submissions/:eahId/history       — OEIS-style version diff history
 *
 * Ownership model: every handler calls fetchOwned() which verifies
 * eah_number = ? AND owner_user_id = ?. 404 if either doesn't match.
 *
 * Note on propose: the spec mentions an optional confirmation page when
 * `?confirm=1` is absent. For simplicity we skip the intermediate step and
 * go directly to the action — the UI makes the intent clear enough.
 */

import { h, raw, type SafeHtml } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { isSuspended } from "../auth.ts";
import { query, queryOne, transaction } from "../db.ts";
import { tokenForRequest, verifyCsrf } from "../csrf.ts";
import { CATEGORIES, categoryLabel, isValidCategory } from "../categories.ts";
import { allocateEahNumber, formatEahId, freeEahNumber } from "../eah-id.ts";
import { recordVersionDiffs, type TrackedValues } from "../versions.ts";
import { notifyNewSubmission } from "../discord.ts";
import {
  type TranscriptMode, type Turn,
  normalizeMode, effectiveTurns, renderConversation, renderTranscriptFields,
  readTranscriptForm, applyTurnAction, deriveLegacyPair, serializeTranscript,
} from "../turns.ts";
import { loadTurns, replaceTurns } from "../turns-db.ts";
import { statusBadge, tierBadge, tierLabel, actionBar } from "./my-shared.ts";
import { longField, renderCardConversation } from "./browse.ts";
import { renderNote, type MessageRow } from "./my-discussion.ts";
import { MAX_PENDING_PER_USER } from "./submit.ts";
import { parseForm, sanitizeText, type RouteHandler } from "./types.ts";

// ─── constants ──────────────────────────────────────────────────────────────

const LIMITS = {
  title: 200,
  prompt: 8000,
  output: 32000,
  ai_model: 120,
  summary: 2000,
  notes: 4000,
  shared_chat_url: 2048,
  author_name: 80,
  tags: 600,
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

type DashboardTier = "draft" | "pending-review" | "pending-acceptance" | "active" | "rejected";

const DASHBOARD_TIERS: Array<{ key: DashboardTier; label: string }> = [
  { key: "draft", label: "Draft" },
  { key: "pending-review", label: "Pending review" },
  { key: "pending-acceptance", label: "Pending acceptance" },
  { key: "active", label: "Active" },
  { key: "rejected", label: "Rejected" },
];

function dashboardTierForRow(status: string, reproStatus: string): DashboardTier {
  if (status === "draft") return "draft";
  if (status === "unreviewed" || status === "pending") return "pending-review";
  if (status === "reviewed" && reproStatus === "pending") return "pending-acceptance";
  if (status === "reviewed" && reproStatus === "reproduced") return "active";
  return "rejected";
}

function dashboardTierWhere(tier: DashboardTier): string {
  switch (tier) {
    case "draft": return "status = 'draft'";
    case "pending-review": return "status = 'unreviewed'";
    case "pending-acceptance": return "status = 'reviewed' AND repro_status = 'pending'";
    case "active": return "status = 'reviewed' AND repro_status = 'reproduced'";
    case "rejected": return "(status = 'rejected' OR (status = 'reviewed' AND repro_status = 'failed'))";
  }
}

// Inline magnifier for the dashboard search box (same glyph as browse).
const MY_SEARCH_ICON =
  `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="12.8" y1="12.8" x2="18" y2="18"/></svg>`;

/** Escape LIKE wildcards so user search input is matched literally. */
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ─── types ───────────────────────────────────────────────────────────────────

interface SubmissionRow {
  id: number;
  eah_number: number | null;
  repro_status: string;
  owner_user_id: number;
  status: string;
  title: string | null;
  prompt: string;
  output: string;
  ai_model: string;
  category: string;
  summary: string | null;
  notes: string | null;
  shared_chat_url: string | null;
  source_url: string | null;
  author_name: string | null;
  hallucination_date: string | null;
  entry_status: string;
  public_id: string;
  submitted_at: Date;
  anon_public: number;
  allow_author_edits: number;
  transcript_mode: string;
  rejection_reason: string | null;
}

interface EditFormValues {
  title: string;
  // Transcript (mirrors submit.ts): mode + structured turns + pasted block.
  mode: TranscriptMode;
  turns: Turn[];
  block: string;
  userDelim: string;
  assistantDelim: string;
  ai_model: string;
  category: string;
  tags: string;
  summary: string;
  notes: string;
  shared_chat_url: string;
  hallucination_date: string;
  entry_status: "active" | "patched";
  anon_public: boolean;
  allow_author_edits: boolean;
}

function dateInputValue(value: string | Date | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/**
 * Callout shown on a rejected submission's pages. A rejected entry behaves like
 * a draft (editable, deletable) but is labeled "rejected" and invites the owner
 * to revise and resubmit. Returns empty for any other status.
 */
function rejectionBanner(row: SubmissionRow): SafeHtml {
  if (row.status !== "rejected") return raw("");
  return h`<div class="complaint-thanks" role="status">
    <p><strong>This submission was rejected by staff.</strong> It's back in your hands —
       revise it below and submit it for review again. Your edits and discussion are kept.</p>
    ${row.rejection_reason ? h`<p><strong>Reason given:</strong> ${row.rejection_reason}</p>` : raw("")}
  </div>`;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Load a submission by its public_id slug, verifying it belongs to the given
 * user. Owner routes address by slug because A-numbers only exist once an entry
 * is reproduced. Returns null if the slug is blank, the row doesn't exist, or
 * the owner doesn't match.
 */
async function fetchOwned(slug: string, userId: number): Promise<SubmissionRow | null> {
  if (!slug) return null;
  const row = await queryOne<SubmissionRow>(
    `SELECT id, eah_number, repro_status, owner_user_id, status, title, prompt, output, ai_model,
            category, summary, notes, shared_chat_url, source_url, author_name, hallucination_date,
            entry_status, public_id, submitted_at, anon_public, allow_author_edits,
            transcript_mode, rejection_reason
       FROM submissions
      WHERE public_id = ? AND owner_user_id = ?`,
    [slug, userId],
  );
  return row ?? null;
}

function parseTags(raw: string): { ok: true; tags: string[] } | { ok: false; error: string } {
  if (!raw || raw.trim().length === 0) return { ok: true, tags: [] };
  const parts = raw.split(",").map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0);
  if (parts.length > 10) return { ok: false, error: "Too many tags (max 10)." };
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const p of parts) {
    if (p.length > 40) return { ok: false, error: `Tag "${p}" is too long (max 40 chars).` };
    if (!/^[a-z0-9-]+$/.test(p)) {
      return { ok: false, error: `Tag "${p}" must use only lowercase letters, digits, and hyphens.` };
    }
    if (seen.has(p)) continue;
    seen.add(p);
    tags.push(p);
  }
  return { ok: true, tags };
}

function parseDate(s: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const v = s.trim();
  if (v.length === 0) return { ok: true, value: null };
  const m = DATE_RE.exec(v);
  if (!m) return { ok: false, error: "Date must be YYYY-MM-DD." };
  const y = parseInt(m[1]!, 10), mo = parseInt(m[2]!, 10), d = parseInt(m[3]!, 10);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: "Not a real calendar date." };
  }
  return { ok: true, value: v };
}

function readEditForm(form: URLSearchParams): EditFormValues {
  const scrub = (k: string) => sanitizeText(form.get(k) ?? "").trim();
  const scrubText = (s: string) => sanitizeText(s);
  const esRaw = scrub("entry_status");

  const mode: TranscriptMode = form.get("transcript_mode") === "block" ? "block" : "turns";
  const roles = form.getAll("turn_role");
  const contents = form.getAll("turn_content");
  const turns: Turn[] = [];
  const n = Math.max(roles.length, contents.length);
  for (let i = 0; i < n; i++) {
    turns.push({
      role: (roles[i] ?? "user").toLowerCase() === "assistant" ? "assistant" : "user",
      content: scrubText(contents[i] ?? ""),
    });
  }

  return {
    title: scrub("title"),
    mode,
    turns: turns.length > 0 ? turns : [
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ],
    block: scrubText(form.get("transcript_block") ?? ""),
    userDelim: scrubText(form.get("block_user_delim") ?? "").slice(0, 80),
    assistantDelim: scrubText(form.get("block_assistant_delim") ?? "").slice(0, 80),
    ai_model: scrub("ai_model"),
    category: scrub("category"),
    tags: scrub("tags"),
    summary: scrub("summary"),
    notes: scrub("notes"),
    shared_chat_url: scrub("shared_chat_url"),
    hallucination_date: scrub("hallucination_date"),
    entry_status: esRaw === "patched" ? "patched" : "active",
    anon_public: form.get("anon_public") === "1",
    allow_author_edits: form.get("allow_author_edits") === "1",
  };
}

function validateEditForm(
  values: EditFormValues,
  form: URLSearchParams,
):
  | { ok: true; tags: string[]; date: string | null; mode: TranscriptMode; turns: Turn[] }
  | { ok: false; error: string } {
  if (!values.title) return { ok: false, error: "Title is required." };
  if (values.title.length > LIMITS.title) return { ok: false, error: `Title too long (max ${LIMITS.title}).` };

  // Validate the conversation (turns or pasted block).
  const transcript = readTranscriptForm(form, (s) => sanitizeText(s));
  if (!transcript.ok) return { ok: false, error: transcript.error };

  if (!values.ai_model) return { ok: false, error: "AI model is required." };
  if (values.ai_model.length > LIMITS.ai_model) return { ok: false, error: `Model name too long (max ${LIMITS.ai_model}).` };
  // Optional; staff categorize before publish. Validate only if one was picked.
  if (values.category && !isValidCategory(values.category)) return { ok: false, error: "Pick a valid category, or leave it blank." };
  if (values.summary.length > LIMITS.summary) return { ok: false, error: `Summary too long (max ${LIMITS.summary}).` };
  if (values.notes.length > LIMITS.notes) return { ok: false, error: `Notes too long (max ${LIMITS.notes}).` };

  if (values.shared_chat_url.length > 0) {
    try {
      const u = new URL(values.shared_chat_url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      return { ok: false, error: "Shared chat URL must be a valid http(s) URL." };
    }
    if (values.shared_chat_url.length > LIMITS.shared_chat_url) {
      return { ok: false, error: "Shared chat URL is too long." };
    }
  }

  if (values.tags.length > LIMITS.tags) return { ok: false, error: "Tags input is too long." };
  const tagResult = parseTags(values.tags);
  if (!tagResult.ok) return { ok: false, error: tagResult.error };

  const dateResult = parseDate(values.hallucination_date);
  if (!dateResult.ok) return { ok: false, error: dateResult.error };

  return { ok: true, tags: tagResult.tags, date: dateResult.value, mode: transcript.mode, turns: transcript.turns };
}

function renderEditForm(opts: {
  slug: string;
  values: EditFormValues;
  csrf: string;
  error: string | null;
  username: string;
}): SafeHtml {
  const { slug, values, csrf, error, username } = opts;
  const action = `/my/submissions/${slug}/edit`;

  const errBlock = error
    ? h`<div class="form-error" role="alert"><strong>Error:</strong> ${error}</div>`
    : h``;

  const categoryOptions = h`${CATEGORIES.map(
    (c) => h`<option value="${c.key}" ${values.category === c.key ? raw("selected") : raw("")}>${c.label}</option>`,
  )}`;

  return h`
    ${errBlock}
    <form method="post" action="${action}" class="submit-form">
      <input type="hidden" name="_csrf" value="${csrf}">

      <label for="title">Title</label>
      <input id="title" name="title" type="text" maxlength="${LIMITS.title}"
             required value="${values.title}">

      <label for="ai_model">AI model</label>
      <input id="ai_model" name="ai_model" type="text" maxlength="${LIMITS.ai_model}"
             required value="${values.ai_model}">

      <label for="category">Category <small>(optional — staff will categorize it during review)</small></label>
      <select id="category" name="category">
        <option value="">-- let staff choose --</option>
        ${categoryOptions}
      </select>

      ${renderTranscriptFields({ mode: values.mode, turns: values.turns, block: values.block, userDelim: values.userDelim, assistantDelim: values.assistantDelim })}

      <label for="summary">Summary <small>(optional)</small></label>
      <textarea id="summary" name="summary" rows="3" maxlength="${LIMITS.summary}"
                data-char-count="summary-count">${values.summary}</textarea>
      <small id="summary-count" class="char-count">0 / ${LIMITS.summary} chars</small>

      <label for="notes">Notes <small>(optional)</small></label>
      <textarea id="notes" name="notes" rows="4" maxlength="${LIMITS.notes}"
                data-char-count="notes-count">${values.notes}</textarea>
      <small id="notes-count" class="char-count">0 / ${LIMITS.notes} chars</small>

      <label for="hallucination_date">Date of hallucination <small>(optional; YYYY-MM-DD)</small></label>
      <input id="hallucination_date" name="hallucination_date" type="date"
             value="${values.hallucination_date}">

      <label for="shared_chat_url">Shared chat URL <small>(optional)</small></label>
      <input id="shared_chat_url" name="shared_chat_url" type="url"
             maxlength="${LIMITS.shared_chat_url}" value="${values.shared_chat_url}"
             placeholder="https://...">

      <label for="tags">Tags <small>(comma-separated; lowercase, digits, hyphens; max 10)</small></label>
      <input id="tags" name="tags" type="text" maxlength="${LIMITS.tags}"
             value="${values.tags}" placeholder="e.g. counting, strawberry, letter-r">

      <p class="field-checkbox">
        <label class="checkbox-label">
          <input type="checkbox" name="anon_public" value="1"
                 ${values.anon_public ? raw("checked") : raw("")}>
          Make this submission anonymous to the public.
        </label>
        <span class="field-hint"><small>By default your username
          (<strong>${username}</strong>) is shown publicly as the author. Check
          this to stay anonymous — the public entry will say "anonymous" and
          only staff will be able to see that you submitted it.</small></span>
      </p>

      <p class="field-checkbox">
        <label class="checkbox-label">
          <input type="checkbox" name="allow_author_edits" value="1"
                 ${values.allow_author_edits ? raw("checked") : raw("")}>
          Allow ENAIH staff to edit this submission's content. Staff can always
          update its active/patched status regardless of this setting, and you can
          always edit it yourself.
        </label>
      </p>

      <label for="entry_status">Entry status</label>
      <select id="entry_status" name="entry_status">
        <option value="active" ${values.entry_status === "active" ? raw("selected") : raw("")}>Active (still reproduces)</option>
        <option value="patched" ${values.entry_status === "patched" ? raw("selected") : raw("")}>Patched (model updated)</option>
      </select>

      <div class="form-actions">
        <button type="submit">Save changes</button>
      </div>
    </form>
  `;
}

/** Read-only metadata block for the overview page. `turns` is the stored
 *  multi-turn transcript (empty for legacy/'single' rows — synthesized from
 *  prompt/output). */
function renderReadOnlyInfo(row: SubmissionRow, tags: string[], turns: Turn[]): SafeHtml {
  const isLink = normalizeMode(row.transcript_mode) === "link";
  const convoTurns = effectiveTurns(normalizeMode(row.transcript_mode), turns, row.prompt, row.output);
  return h`
    <dl class="entry-meta">
      <dt>Title</dt><dd>${row.title ?? "(none)"}</dd>
      <dt>Status</dt><dd>${tierBadge(row.status, row.repro_status)}</dd>
      <dt>AI model</dt><dd>${row.ai_model}</dd>
      <dt>Category</dt><dd>${categoryLabel(row.category)}</dd>
      ${row.hallucination_date ? h`<dt>Date</dt><dd>${row.hallucination_date}</dd>` : raw("")}
      ${tags.length > 0 ? h`<dt>Tags</dt><dd>${tags.join(", ")}</dd>` : raw("")}
    </dl>
    ${isLink
      ? h`${row.source_url ? h`<h2>Source</h2><p><a href="${row.source_url}" rel="nofollow noopener">${row.source_url}</a></p>` : raw("")}
          ${row.summary ? h`<h2>What's wrong</h2><p>${row.summary}</p>` : raw("")}`
      : h`<h2>${convoTurns.length > 2 ? raw("Conversation") : raw("Prompt &amp; response")}</h2>
          ${renderConversation(convoTurns, longField, 0)}
          ${row.summary ? h`<h2>Summary</h2><p>${row.summary}</p>` : raw("")}`}
    ${row.notes ? h`<h2>Notes</h2><p>${row.notes}</p>` : raw("")}
  `;
}

interface VersionRow {
  id: number;
  version_num: number;
  changed_by: number | null;
  changed_at: Date;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  changed_by_username: string | null;
}

/** Render grouped version diffs (shared by the history page and overview). */
function renderHistoryBody(versionRows: VersionRow[]): SafeHtml {
  if (versionRows.length === 0) return h`<p>No edits recorded yet.</p>`;

  const groups = new Map<number, VersionRow[]>();
  for (const r of versionRows) {
    const g = groups.get(r.version_num) ?? [];
    g.push(r);
    groups.set(r.version_num, g);
  }

  const groupHtml = [...groups.entries()].map(([vNum, fields]) => {
    const first = fields[0]!;
    const ts = new Date(first.changed_at);
    const dateStr = ts.toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const byLine = first.changed_by_username
      ? h`by ${first.changed_by_username}`
      : h`by (deleted user)`;

    const fieldLines = fields.map((f) => {
      const delPart = f.old_value !== null ? h`<del class="diff-del">${f.old_value}</del>` : raw("");
      const insPart = f.new_value !== null ? h`<ins class="diff-add">${f.new_value}</ins>` : raw("");
      return h`
        <div class="history-entry">
          <div class="history-field-name">${f.field_name}</div>
          <div class="history-diff">${delPart} ${insPart}</div>
        </div>
      `;
    });

    return h`
      <div class="history-version">
        <div class="history-version-header">#${String(vNum)} · ${byLine} · ${dateStr}</div>
        ${fieldLines}
      </div>
    `;
  });

  return h`${groupHtml}`;
}

async function loadVersions(submissionId: number): Promise<VersionRow[]> {
  return query<VersionRow>(
    `SELECT v.id, v.version_num, v.changed_by, v.changed_at,
            v.field_name, v.old_value, v.new_value,
            u.username AS changed_by_username
       FROM submission_versions v
       LEFT JOIN users u ON u.id = v.changed_by
      WHERE v.submission_id = ?
      ORDER BY v.version_num ASC, v.id ASC`,
    [submissionId],
  );
}

// ─── mySubmissions ────────────────────────────────────────────────────────────

export const mySubmissions: RouteHandler = async (req, ctx) => {
  if (!ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  const sp = ctx.url.searchParams;

  // Status filter (one of the dashboard-visible tiers; withdrawn is always
  // excluded). An unrecognized value falls back to "all".
  const statusRaw = (sp.get("status") ?? "").trim();
  const statusFilter = DASHBOARD_TIERS.some((t) => t.key === statusRaw) ? statusRaw : "";

  // Free-text search across the user's own submissions.
  const q = (sp.get("q") ?? "").trim().slice(0, 200);

  // Shared WHERE (everything except the status filter) + params, reused for the
  // faceted per-tier counts so each count reflects the active search.
  const baseWhere: string[] = ["owner_user_id = ?", "status != 'withdrawn'"];
  const baseParams: unknown[] = [ctx.user.userId];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    baseWhere.push(
      "(title LIKE ? ESCAPE '\\\\' OR prompt LIKE ? ESCAPE '\\\\' OR output LIKE ? ESCAPE '\\\\' OR ai_model LIKE ? ESCAPE '\\\\')",
    );
    baseParams.push(like, like, like, like);
  }

  // Per-tier counts for the filter bar (honor search, ignore active filter).
  const countRows = await query<{ status: string; repro_status: string; n: number | bigint }>(
    `SELECT status, repro_status, COUNT(*) AS n FROM submissions WHERE ${baseWhere.join(" AND ")} GROUP BY status, repro_status`,
    baseParams,
  );
  const statusCounts = new Map<string, number>();
  let allCount = 0;
  for (const r of countRows) {
    const n = Number(r.n);
    const tier = dashboardTierForRow(r.status, r.repro_status);
    statusCounts.set(tier, n);
    allCount += n;
  }

  // Whether the user has ANY submissions at all (ignoring the active search /
  // status filter) — drives "no submissions yet" vs "no submissions match".
  const ownedRow = await queryOne<{ n: number | bigint }>(
    "SELECT COUNT(*) AS n FROM submissions WHERE owner_user_id = ? AND status != 'withdrawn'",
    [ctx.user.userId],
  );
  const totalOwned = Number(ownedRow?.n ?? 0);

  const listWhere = [...baseWhere];
  const listParams = [...baseParams];
  if (statusFilter) {
    listWhere.push(dashboardTierWhere(statusFilter as DashboardTier));
  }

  const rows = await query<{
    id: number;
    eah_number: number | null;
    repro_status: string;
    public_id: string;
    title: string | null;
    status: string;
    ai_model: string;
    category: string;
    prompt: string;
    output: string;
    transcript_mode: string;
    submitted_at: Date;
  }>(
    `SELECT id, eah_number, repro_status, public_id, title, status, ai_model, category,
            prompt, output, transcript_mode, submitted_at
       FROM submissions
      WHERE ${listWhere.join(" AND ")}
      ORDER BY submitted_at DESC`,
    listParams,
  );

  // Filter bar: status links (carry the active search) + a search box (carries
  // the active status). Reuses the browse search-row look at a smaller scale.
  const statusQs = (s: string): string => {
    const u = new URLSearchParams();
    if (s) u.set("status", s);
    if (q) u.set("q", q);
    const qs = u.toString();
    return qs ? `?${qs}` : "";
  };
  const statusFilterLink = (s: string, label: string, n: number) => {
    const active = s === statusFilter;
    const inner = h`${label} <span class="cat-count">(${n})</span>`;
    return active
      ? h`<strong class="filter-pill active">${inner}</strong>`
      : h`<a class="filter-pill" href="/my/submissions${raw(statusQs(s))}">${inner}</a>`;
  };
  const filterBar = h`<div class="my-filter-bar">
    <div class="filter-bar">
      ${statusFilterLink("", "All", allCount)}
      ${DASHBOARD_TIERS.map((s) => statusFilterLink(s.key, s.label, statusCounts.get(s.key) ?? 0))}
    </div>
    <form action="/my/submissions" method="get" class="my-search-form">
      ${statusFilter ? h`<input type="hidden" name="status" value="${statusFilter}">` : h``}
      <div class="search-row">
        <input type="search" name="q" value="${q}" placeholder="search your submissions…" maxlength="200">
        <button type="submit" class="search-go" aria-label="Search">${raw(MY_SEARCH_ICON)}</button>
      </div>
    </form>
  </div>`;

  // Batch-load turns for multi-turn rows (same cheap pattern as browse).
  const turnsByRow = new Map<number, Turn[]>();
  const multiTurnIds = rows.filter((r) => normalizeMode(r.transcript_mode) !== "single").map((r) => r.id);
  if (multiTurnIds.length > 0) {
    const ph = multiTurnIds.map(() => "?").join(",");
    const turnRows = await query<{ submission_id: number; role: "user" | "assistant"; content: string }>(
      `SELECT submission_id, role, content FROM submission_turns
        WHERE submission_id IN (${ph})
        ORDER BY submission_id ASC, turn_index ASC, id ASC`,
      multiTurnIds,
    );
    for (const tr of turnRows) {
      const arr = turnsByRow.get(tr.submission_id) ?? [];
      arr.push({ role: tr.role, content: tr.content });
      turnsByRow.set(tr.submission_id, arr);
    }
  }

  const { token } = tokenForRequest(req);

  const infoRow = (label: string, value: SafeHtml): SafeHtml => h`<dt>${label}</dt><dd>${value}</dd>`;

  // Each submission renders as a browse-style collapsible card: colored header
  // (title + status chip), then the info grid, prompt/output preview, and the
  // shared action bar. Open by default to match the public browse listing.
  const items = rows.map((row) => {
    const eahId = formatEahId(row.eah_number);
    const slug = row.public_id;
    const submittedDate = new Date(row.submitted_at).toISOString().slice(0, 10);

    // Overview is addressed by slug (every row has one). Only drafts lack an
    // A-number now — show it when present, else a dash.
    const idCell = eahId
      ? h`<a href="/my/submissions/${slug}"><code>${eahId}</code></a>`
      : h`<span class="muted">— (drafts do not get an A-number)</span>`;

    const titleInner = row.title ?? h`<em>(untitled)</em>`;
    const titleEl = h`<a class="entry-card-title" href="/my/submissions/${slug}">${titleInner}</a>`;

    return h`<li class="entry-card">
      <details open>
        <summary class="entry-card-head">
          ${titleEl}
          <span class="entry-card-status">${tierLabel(row.status, row.repro_status)}</span>
          <span class="entry-card-chevron" aria-hidden="true"></span>
        </summary>
        <div class="entry-card-body">
          <dl class="entry-info">
            ${infoRow("Entry ID", idCell)}
            ${infoRow("Model", h`${row.ai_model}`)}
            ${infoRow("Category", h`${categoryLabel(row.category)}`)}
            ${infoRow("Submitted", h`${submittedDate}`)}
          </dl>
          ${renderCardConversation(row, turnsByRow.get(row.id) ?? [])}
          <div class="my-sub-actions">${actionBar(slug, row.status, token, eahId)}</div>
        </div>
      </details>
    </li>`;
  });

  const rule = h`<p class="field-hint"><small>Drafts are unlimited. You may have at
    most ${MAX_PENDING_PER_USER} submissions <strong>still pending review</strong> at
    once — submit a draft for review to put it live. If you run out of room, you can
    just wait for staff to review one of them, or withdraw a pending one back to a
    draft to free up a slot.</small></p>`;

  const body = totalOwned === 0
    ? h`${rule}<p>No submissions yet. <a href="/submit">Submit one</a>.</p>`
    : h`
        ${rule}
        ${filterBar}
        ${rows.length === 0
          ? h`<p class="empty"><em>No submissions match.</em> <a href="/my/submissions">Clear filters</a>.</p>`
          : h`<ul class="entry-list">${items}</ul>`}
        <p><a href="/submit">Submit another</a></p>
      `;

  return pageResponse(req, {
    title: "My submissions · ENAIH",
    heading: "My submissions",
    // Wider-than-default reading column: the dashboard cards were too cramped in
    // the 760px default. Roughly 2× wide, but still centered (not full-bleed).
    bodyClass: "dashboard-wide",
    body,
    user: ctx.user,
  });
};

// ─── myEditGet ────────────────────────────────────────────────────────────────

export const myEditGet: RouteHandler = async (req, ctx) => {
  if (!ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  const eahIdStr = ctx.params.eahId ?? "";
  const row = await fetchOwned(eahIdStr, ctx.user.userId);
  if (!row) {
    return pageResponse(req, {
      title: "Not found · ENAIH",
      heading: "Not found",
      body: h`<p>Submission not found. <a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 404 });
  }

  const eahId = formatEahId(row.eah_number);
  const slug = row.public_id;
  const dispId = eahId || row.title || slug;

  // Drafts, pending-review, and rejected submissions are editable here (rejected
  // ones so the owner can revise before resubmitting). Later tiers are read-only
  // — send them to the overview.
  if (row.status !== "draft" && row.status !== "unreviewed" && row.status !== "rejected") {
    return new Response(null, { status: 303, headers: { Location: `/my/submissions/${slug}` } });
  }
  // The structured editor is transcript-only. Link submissions aren't editable
  // here — to change one, delete and resubmit. Send them to the overview.
  if (normalizeMode(row.transcript_mode) === "link") {
    return new Response(null, { status: 303, headers: { Location: `/my/submissions/${slug}` } });
  }

  const { token, setCookie } = tokenForRequest(req);

  // Load current tags for the form
  const tagRows = await query<{ name: string }>(
    `SELECT t.name FROM tags t
       JOIN submission_tags st ON st.tag_id = t.id
      WHERE st.submission_id = ?
      ORDER BY t.name ASC`,
    [row.id],
  );

  // Seed the conversation editor from stored turns (legacy/'single' rows
  // synthesize a [prompt, output] pair). Mode 'block' falls back to the
  // structured editor for editing — we re-derive a clean transcript on save.
  const storedMode = normalizeMode(row.transcript_mode);
  const storedTurns = await loadTurns(row.id);
  const seedTurns = effectiveTurns(storedMode, storedTurns, row.prompt, row.output);
  const editMode: TranscriptMode = storedMode === "block" ? "block" : "turns";

  const values: EditFormValues = {
    title: row.title ?? "",
    mode: editMode,
    turns: seedTurns.length > 0 ? seedTurns : [
      { role: "user", content: row.prompt },
      { role: "assistant", content: row.output },
    ],
    // For block mode, reconstruct an editable delimited block from the turns.
    block: storedMode === "block"
      ? seedTurns.map((t) => `### ${t.role === "assistant" ? "Assistant" : "User"}\n${t.content}`).join("\n\n")
      : "",
    userDelim: "",
    assistantDelim: "",
    ai_model: row.ai_model,
    category: row.category,
    tags: tagRows.map((t) => t.name).join(", "),
    summary: row.summary ?? "",
    notes: row.notes ?? "",
    shared_chat_url: row.shared_chat_url ?? "",
    hallucination_date: dateInputValue(row.hallucination_date),
    entry_status: row.entry_status === "patched" ? "patched" : "active",
    anon_public: row.anon_public === 1,
    allow_author_edits: row.allow_author_edits === 1,
  };

  const saved = ctx.url.searchParams.get("saved") === "1";
  const savedFlash = saved ? h`<div class="flash-success">Saved.</div>` : raw("");

  const formHtml = renderEditForm({ slug, values, csrf: token, error: null, username: ctx.user.username });

  const body = h`
    ${savedFlash}
    ${rejectionBanner(row)}
    <p>${statusBadge(row.status)}</p>
    ${formHtml}
  `;

  return pageResponse(req, {
    title: `Edit ${dispId} · ENAIH`,
    heading: `Edit ${dispId}`,
    body,
    user: ctx.user,
    subnav: actionBar(slug, row.status, token, eahId),
  }, { setCookie });
};

// ─── myEditPost ───────────────────────────────────────────────────────────────

export const myEditPost: RouteHandler = async (req, ctx) => {
  if (!ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  const eahIdStr = ctx.params.eahId ?? "";

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 128 * 1024);
  } catch {
    return pageResponse(req, {
      title: "Error · ENAIH",
      heading: "Error",
      body: h`<p>Form too large.</p>`,
      user: ctx.user,
    }, { status: 413 });
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    return pageResponse(req, {
      title: "Forbidden · ENAIH",
      heading: "Forbidden",
      body: h`<p>Invalid CSRF token. Please reload and try again.</p>`,
      user: ctx.user,
    }, { status: 403 });
  }

  const row = await fetchOwned(eahIdStr, ctx.user.userId);
  // Drafts, pending review, and rejected submissions are all editable.
  if (!row || (row.status !== "draft" && row.status !== "unreviewed" && row.status !== "rejected")) {
    return pageResponse(req, {
      title: "Not found · ENAIH",
      heading: "Not found",
      body: h`<p>Submission not found. <a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 404 });
  }

  const slug = row.public_id;
  // Link submissions aren't editable via the transcript editor (see myEditGet).
  if (normalizeMode(row.transcript_mode) === "link") {
    return new Response(null, { status: 303, headers: { Location: `/my/submissions/${slug}` } });
  }
  const eahId = formatEahId(row.eah_number);
  const dispId = eahId || row.title || slug;
  const values = readEditForm(form);

  // No-JS fallback: "Add turn" / "Remove turn" re-render the form (no save).
  const action = form.get("action") ?? "";
  const turnAction = applyTurnAction(action, values.turns);
  if (turnAction) {
    const { token, setCookie } = tokenForRequest(req);
    const formHtml = renderEditForm({
      slug, values: { ...values, turns: turnAction }, csrf: token, error: null, username: ctx.user.username,
    });
    const body = h`${rejectionBanner(row)}<p>${statusBadge(row.status)}</p>${formHtml}`;
    return pageResponse(req, {
      title: `Edit ${dispId} · ENAIH`,
      heading: `Edit ${dispId}`,
      body,
      user: ctx.user,
      subnav: actionBar(slug, row.status, token, eahId),
    }, { setCookie });
  }

  const v = validateEditForm(values, form);

  if (!v.ok) {
    const { token, setCookie } = tokenForRequest(req);
    const formHtml = renderEditForm({ slug, values, csrf: token, error: v.error, username: ctx.user.username });
    const body = h`
      ${rejectionBanner(row)}
      <p>${statusBadge(row.status)}</p>
      ${formHtml}
    `;
    return pageResponse(req, {
      title: `Edit ${dispId} · ENAIH`,
      heading: `Edit ${dispId}`,
      body,
      user: ctx.user,
      subnav: actionBar(slug, row.status, token, eahId),
    }, { status: 400, setCookie });
  }

  const userId = ctx.user.userId;

  // Derive the stored shape + legacy prompt/output mirror from the validated
  // conversation. A single user turn or a [user, assistant] pair collapses to
  // 'single' (no turn rows). Anything richer keeps its mode + turn rows.
  const isTrivial =
    v.turns.length <= 1 ||
    (v.turns.length === 2 && v.turns[0]!.role === "user" && v.turns[1]!.role === "assistant");
  const storedMode: TranscriptMode = isTrivial ? "single" : v.mode;
  const storedTurns: Turn[] = storedMode === "single" ? [] : v.turns;
  const { prompt: legacyPrompt, output: legacyOutput } = deriveLegacyPair(v.turns);

  // Current transcript (for version diffing): serialize what's stored now.
  const currentStoredMode = normalizeMode(row.transcript_mode);
  const currentStoredTurns = currentStoredMode === "single" ? [] : await loadTurns(row.id);

  // Load current tags as a sorted comma-joined string so we can diff them.
  const currentTagRows = await query<{ name: string }>(
    `SELECT t.name FROM tags t
       JOIN submission_tags st ON st.tag_id = t.id
      WHERE st.submission_id = ?
      ORDER BY t.name ASC`,
    [row.id],
  );
  const currentTagString = currentTagRows.map((r) => r.name).join(",");
  const newTagString = [...v.tags].sort().join(",");

  const currentValues: TrackedValues = {
    title: row.title ?? null,
    prompt: row.prompt,
    output: row.output,
    ai_model: row.ai_model,
    summary: row.summary ?? null,
    notes: row.notes ?? null,
    shared_chat_url: row.shared_chat_url ?? null,
    category: row.category,
    hallucination_date: row.hallucination_date ?? null,
    entry_status: row.entry_status,
    tags: currentTagString || null,
    transcript: serializeTranscript(currentStoredMode, currentStoredTurns),
  };

  const newValues: TrackedValues = {
    title: values.title || null,
    prompt: legacyPrompt,
    output: legacyOutput,
    ai_model: values.ai_model,
    summary: values.summary || null,
    notes: values.notes || null,
    shared_chat_url: values.shared_chat_url || null,
    category: values.category,
    hallucination_date: v.date,
    entry_status: values.entry_status,
    tags: newTagString || null,
    transcript: serializeTranscript(storedMode, storedTurns),
  };

  try {
    await transaction(async (tx) => {
      // Record diffs before updating so currentValues is still accurate.
      await recordVersionDiffs(tx, row.id, userId, currentValues, newValues);

      await tx.execute(
        `UPDATE submissions
            SET title = ?, prompt = ?, output = ?, ai_model = ?, summary = ?, notes = ?,
                shared_chat_url = ?, category = ?,
                hallucination_date = ?, entry_status = ?, anon_public = ?, allow_author_edits = ?,
                transcript_mode = ?
          WHERE id = ?`,
        [
          values.title || null,
          legacyPrompt,
          legacyOutput,
          values.ai_model,
          values.summary || null,
          values.notes || null,
          values.shared_chat_url || null,
          values.category,
          v.date,
          values.entry_status,
          values.anon_public ? 1 : 0,
          values.allow_author_edits ? 1 : 0,
          storedMode,
          row.id,
        ],
      );

      // Replace the multi-turn rows (none for 'single').
      await replaceTurns(tx, row.id, storedTurns);

      // Replace tag set.
      await tx.execute("DELETE FROM submission_tags WHERE submission_id = ?", [row.id]);
      for (const tag of v.tags) {
        await tx.execute("INSERT IGNORE INTO tags (name) VALUES (?)", [tag]);
        const tagRow = await tx.queryOne<{ id: number }>("SELECT id FROM tags WHERE name = ?", [tag]);
        if (!tagRow) throw new Error(`tag row missing: ${tag}`);
        await tx.execute(
          "INSERT IGNORE INTO submission_tags (submission_id, tag_id) VALUES (?, ?)",
          [row.id, tagRow.id],
        );
      }
    });
  } catch (err) {
    console.error("draft edit failed", err);
    return pageResponse(req, {
      title: "Error · ENAIH",
      heading: "Error",
      body: h`<p>Could not save changes. Please try again.</p>`,
      user: ctx.user,
    }, { status: 500 });
  }

  return new Response(null, {
    status: 303,
    headers: { Location: `/my/submissions/${slug}/edit?saved=1` },
  });
};

// ─── myPropose ────────────────────────────────────────────────────────────────

export const myPropose: RouteHandler = async (req, ctx) => {
  if (!ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  const eahIdStr = ctx.params.eahId ?? "";

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 8 * 1024);
  } catch {
    return new Response(null, { status: 400 });
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    return pageResponse(req, {
      title: "Forbidden · ENAIH",
      heading: "Forbidden",
      body: h`<p>Invalid CSRF token.</p>`,
      user: ctx.user,
    }, { status: 403 });
  }

  // Proposing a draft into the review queue is a form of submitting, so a
  // timed-out user can't do it either. They can still edit/withdraw drafts.
  if (isSuspended(ctx.user)) {
    return pageResponse(req, {
      title: "Timed out · ENAIH",
      heading: "You're timed out",
      body: h`<p>You can't publish a submission while your account is
        timed out${ctx.user.suspendedReason ? h`: <em>${ctx.user.suspendedReason}</em>` : raw("")}.
        You can still edit or withdraw your drafts.</p>
        <p><a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 403 });
  }

  // Drafts and rejected submissions can be (re)submitted for review.
  const row = await fetchOwned(eahIdStr, ctx.user.userId);
  if (!row || (row.status !== "draft" && row.status !== "rejected")) {
    return new Response(null, { status: 404 });
  }
  const slug = row.public_id;
  const wasRejected = row.status === "rejected";

  // Cap on submissions awaiting review (drafts are unlimited; only proposing
  // counts against the quota). Mirrors the check in submit.ts.
  const pendingRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM submissions
      WHERE owner_user_id = ? AND status = 'unreviewed'`,
    [ctx.user.userId],
  );
  const pending = Number(pendingRow?.n ?? 0);
  if (pending >= MAX_PENDING_PER_USER) {
    const dispId = row.title ?? slug;
    return pageResponse(req, {
      title: "Too many awaiting review · ENAIH",
      heading: "Too many submissions awaiting review",
      body: h`<p>You already have ${pending} submissions still pending review, which is the maximum (${MAX_PENDING_PER_USER}). This one
        stays a draft for now.</p>
        <p>To free up a slot, wait for staff to review one of them, or withdraw one back
        to a draft from your submissions page. Then you can submit this one for review.</p>
        <p><a href="/my/submissions/${slug}">Back to ${dispId}</a> ·
           <a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 429 });
  }

  const username = ctx.user.username;
  let proposedEahId = row.eah_number;

  try {
    await transaction(async (tx) => {
      if (proposedEahId === null) {
        proposedEahId = await allocateEahNumber(tx);
      }
      // Resubmitting a rejected entry clears its prior rejection reason.
      await tx.execute(
        "UPDATE submissions SET status = 'unreviewed', eah_number = ?, rejection_reason = NULL WHERE id = ? AND owner_user_id = ? AND status IN ('draft', 'rejected')",
        [proposedEahId, row.id, ctx.user!.userId],
      );
      await tx.execute(
        `INSERT INTO submission_messages (submission_id, sender_type, body) VALUES (?, 'system', ?)`,
        [row.id, wasRejected
          ? `Revised and resubmitted for review by ${username}.`
          : `Submission submitted for review by ${username}.`],
      );
    });
  } catch (err) {
    console.error("propose failed", err);
    return pageResponse(req, {
      title: "Error · ENAIH",
      heading: "Error",
      body: h`<p>Could not propose submission. Please try again.</p>`,
      user: ctx.user,
    }, { status: 500 });
  }

  // Ping the staff Discord channel: this draft just entered the review queue.
  void notifyNewSubmission({
    submissionId: row.id,
    eahId: formatEahId(proposedEahId),
    title: row.title,
    modelLabel: row.ai_model,
    username,
    anon: row.anon_public === 1,
  });

  return new Response(null, { status: 303, headers: { Location: "/my/submissions" } });
};

// ─── withdraw (pending → draft) ──────────────────────────────────────────────

/**
 * GET confirmation page for withdrawing a proposed submission back to draft.
 * Withdraw is the inverse of propose: it pulls the submission out of the review
 * queue and back into your drafts, freeing the A-number while keeping the edit
 * history AND the discussion thread — unlike the old "unpropose", nothing
 * reviewer-side is wiped. To actually discard the submission, withdraw then delete.
 */
export const myWithdrawConfirm: RouteHandler = async (req, ctx) => {
  if (!ctx.user) return new Response(null, { status: 303, headers: { Location: "/login" } });
  const row = await fetchOwned(ctx.params.eahId ?? "", ctx.user.userId);
  if (!row || row.status !== "unreviewed") {
    return pageResponse(req, {
      title: "Not found · ENAIH",
      heading: "Not found",
      body: h`<p>No pending review submission with that ID. <a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 404 });
  }
  const slug = row.public_id;
  const dispId = row.title ?? slug;
  const { token, setCookie } = tokenForRequest(req);
  const body = h`
    <p>Withdraw <strong>${dispId}</strong>? It moves back to your private drafts so you
    can keep editing and submit it for review again later. The discussion with reviewers is kept.</p>
    <form method="post" action="/my/submissions/${slug}/withdraw">
      <input type="hidden" name="_csrf" value="${token}">
      <input type="hidden" name="confirm" value="1">
      <button type="submit" class="btn-secondary">Withdraw</button>
    </form>
    <p><a href="/my/submissions/${slug}">Cancel</a></p>
  `;
  return pageResponse(req, {
    title: `Withdraw ${dispId} · ENAIH`, heading: `Withdraw ${dispId}`, body, user: ctx.user,
  }, { setCookie });
};

export const myWithdraw: RouteHandler = async (req, ctx) => {
  if (!ctx.user) return new Response(null, { status: 303, headers: { Location: "/login" } });

  const eahIdStr = ctx.params.eahId ?? "";

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 8 * 1024);
  } catch {
    return new Response(null, { status: 400 });
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    return pageResponse(req, {
      title: "Forbidden · ENAIH", heading: "Forbidden",
      body: h`<p>Invalid CSRF token. Please reload and try again.</p>`,
      user: ctx.user,
    }, { status: 403 });
  }

  const row = await fetchOwned(eahIdStr, ctx.user.userId);
  if (!row || row.status !== "unreviewed") return new Response(null, { status: 404 });

  const slug = row.public_id;
  const username = ctx.user.username;

  try {
    await transaction(async (tx) => {
      await freeEahNumber(tx, row.id);
      await tx.execute(
        "UPDATE submissions SET status = 'draft' WHERE id = ? AND owner_user_id = ? AND status = 'unreviewed'",
        [row.id, ctx.user!.userId],
      );
      await tx.execute(
        `INSERT INTO submission_messages (submission_id, sender_type, body) VALUES (?, 'system', ?)`,
        [row.id, `Submission withdrawn from review by ${username} — moved back to draft.`],
      );
    });
  } catch (err) {
    console.error("withdraw failed", err);
    return pageResponse(req, {
      title: "Error · ENAIH", heading: "Error",
      body: h`<p>Could not withdraw submission. Please try again.</p>`,
      user: ctx.user,
    }, { status: 500 });
  }

  return new Response(null, { status: 303, headers: { Location: `/my/submissions/${slug}` } });
};

// ─── delete (draft → gone) ───────────────────────────────────────────────────

/** GET confirmation page for permanently deleting a draft. */
export const myDeleteConfirm: RouteHandler = async (req, ctx) => {
  if (!ctx.user) return new Response(null, { status: 303, headers: { Location: "/login" } });
  const row = await fetchOwned(ctx.params.eahId ?? "", ctx.user.userId);
  if (!row || (row.status !== "draft" && row.status !== "rejected")) {
    return pageResponse(req, {
      title: "Not found · ENAIH",
      heading: "Not found",
      body: h`<p>No draft or rejected submission with that ID. Only drafts and rejected
        submissions can be deleted — withdraw a pending one back to a draft first.
        <a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 404 });
  }
  const slug = row.public_id;
  const dispId = row.title ?? slug;
  const { token, setCookie } = tokenForRequest(req);
  const what = row.status === "rejected" ? "rejected submission" : "draft";
  const body = h`
    <p>Delete ${what} <strong>${dispId}</strong>? This permanently removes it, its
    discussion, and its edit history. This can't be undone.</p>
    <form method="post" action="/my/submissions/${slug}/delete">
      <input type="hidden" name="_csrf" value="${token}">
      <input type="hidden" name="confirm" value="1">
      <button type="submit" class="btn-danger">Delete ${what}</button>
    </form>
    <p><a href="/my/submissions/${slug}">Cancel</a></p>
  `;
  return pageResponse(req, {
    title: `Delete ${dispId} · ENAIH`, heading: `Delete ${dispId}`, body, user: ctx.user,
  }, { setCookie });
};

export const myDelete: RouteHandler = async (req, ctx) => {
  if (!ctx.user) return new Response(null, { status: 303, headers: { Location: "/login" } });

  const eahIdStr = ctx.params.eahId ?? "";

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 8 * 1024);
  } catch {
    return new Response(null, { status: 400 });
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    return pageResponse(req, {
      title: "Forbidden · ENAIH", heading: "Forbidden",
      body: h`<p>Invalid CSRF token. Please reload and try again.</p>`,
      user: ctx.user,
    }, { status: 403 });
  }

  // Drafts and rejected submissions can be deleted. Pending ones must be
  // withdrawn back to a draft first.
  const row = await fetchOwned(eahIdStr, ctx.user.userId);
  if (!row || (row.status !== "draft" && row.status !== "rejected")) return new Response(null, { status: 404 });

  try {
    await transaction(async (tx) => {
      // Drafts hold no A-number under the tiered model, so freeEahNumber is a
      // defensive no-op here (legacy drafts that somehow carried one get it
      // recycled). Then hard-delete; child rows cascade via FK.
      await freeEahNumber(tx, row.id);
      await tx.execute("DELETE FROM submissions WHERE id = ?", [row.id]);
    });
  } catch (err) {
    console.error("draft delete failed", err);
    return pageResponse(req, {
      title: "Error · ENAIH", heading: "Error",
      body: h`<p>Could not delete the draft. Please try again.</p>`,
      user: ctx.user,
    }, { status: 500 });
  }

  return new Response(null, { status: 303, headers: { Location: "/my/submissions" } });
};

// ─── myHistory ────────────────────────────────────────────────────────────────

export const myHistory: RouteHandler = async (req, ctx) => {
  if (!ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  const eahIdStr = ctx.params.eahId ?? "";
  const row = await fetchOwned(eahIdStr, ctx.user.userId);
  if (!row) {
    return pageResponse(req, {
      title: "Not found · ENAIH",
      heading: "Not found",
      body: h`<p>Submission not found. <a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 404 });
  }

  const eahId = formatEahId(row.eah_number);
  const slug = row.public_id;
  const dispId = eahId || row.title || slug;
  const { token } = tokenForRequest(req);
  const versionRows = await loadVersions(row.id);

  const body = h`
    <p><strong>${dispId}</strong> · ${tierBadge(row.status, row.repro_status)} · ${row.title ?? "(untitled)"}</p>
    ${renderHistoryBody(versionRows)}
  `;

  return pageResponse(req, {
    title: `History ${dispId} · ENAIH`,
    heading: `Edit history — ${dispId}`,
    body,
    user: ctx.user,
    subnav: actionBar(slug, row.status, token, eahId),
  });
};

// ─── myView (overview / general draft page) ───────────────────────────────────

/**
 * GET /my/submissions/:eahId — the submission's overview page. A single read-
 * only view of everything: metadata, prompt/output, the discussion thread, and
 * the edit history, plus the full action bar. The A-number on the dashboard
 * links here.
 */
export const myView: RouteHandler = async (req, ctx) => {
  if (!ctx.user) return new Response(null, { status: 303, headers: { Location: "/login" } });

  const eahIdStr = ctx.params.eahId ?? "";
  const row = await fetchOwned(eahIdStr, ctx.user.userId);
  if (!row) {
    return pageResponse(req, {
      title: "Not found · ENAIH",
      heading: "Not found",
      body: h`<p>Submission not found. <a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 404 });
  }

  const eahId = formatEahId(row.eah_number);
  const slug = row.public_id;
  const dispId = eahId || row.title || slug;
  const { token, setCookie } = tokenForRequest(req);

  const tagRows = await query<{ name: string }>(
    `SELECT t.name FROM tags t
       JOIN submission_tags st ON st.tag_id = t.id
      WHERE st.submission_id = ?
      ORDER BY t.name ASC`,
    [row.id],
  );

  const messages = await query<MessageRow>(
    `SELECT m.id, m.submission_id, m.sender_type, m.sender_user_id,
            m.body, m.created_at, u.username AS sender_username
       FROM submission_messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
      WHERE m.submission_id = ?
      ORDER BY m.created_at ASC`,
    [row.id],
  );

  const versionRows = await loadVersions(row.id);

  const thread = messages.length > 0
    ? h`<div class="discuss-thread">${messages.map(renderNote)}</div>
        <p><a href="/my/submissions/${slug}/discussion">Open discussion to reply →</a></p>`
    : h`<p class="muted">No messages yet. <a href="/my/submissions/${slug}/discussion">Start a discussion →</a></p>`;

  // 'single' and 'link' rows have no submission_turns; only multi-turn shapes load them.
  const sharedMode = normalizeMode(row.transcript_mode);
  const convoTurns = sharedMode === "single" || sharedMode === "link" ? [] : await loadTurns(row.id);

  const body = h`
    ${rejectionBanner(row)}
    ${renderReadOnlyInfo(row, tagRows.map((t) => t.name), convoTurns)}
    <h2>Discussion</h2>
    ${thread}
    <h2>Edit history</h2>
    ${renderHistoryBody(versionRows)}
  `;

  return pageResponse(req, {
    title: `${dispId} · ENAIH`,
    heading: `${dispId} — ${row.title ?? "(untitled)"}`,
    body,
    user: ctx.user,
    subnav: actionBar(slug, row.status, token, eahId),
  }, { setCookie });
};
