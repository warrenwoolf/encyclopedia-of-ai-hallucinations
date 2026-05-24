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
import { CATEGORIES, isValidCategory } from "../categories.ts";
import { formatEahId, parseEahId, freeEahNumber } from "../eah-id.ts";
import { recordVersionDiffs, type TrackedValues } from "../versions.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteHandler } from "./types.ts";

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

// ─── types ───────────────────────────────────────────────────────────────────

interface SubmissionRow {
  id: number;
  eah_number: number;
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
  author_name: string | null;
  hallucination_date: string | null;
  entry_status: string;
  public_id: string;
  submitted_at: Date;
  anon_public: number;
  allow_author_edits: number;
}

interface EditFormValues {
  title: string;
  prompt: string;
  output: string;
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

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Load a submission by A-number, verifying it belongs to the given user.
 * Returns null if the A-number is invalid, the row doesn't exist, or the
 * owner doesn't match.
 */
async function fetchOwned(eahIdStr: string, userId: number): Promise<SubmissionRow | null> {
  const n = parseEahId(eahIdStr);
  if (n === null) return null;
  const row = await queryOne<SubmissionRow>(
    `SELECT id, eah_number, owner_user_id, status, title, prompt, output, ai_model,
            category, summary, notes, shared_chat_url, author_name, hallucination_date,
            entry_status, public_id, submitted_at, anon_public, allow_author_edits
       FROM submissions
      WHERE eah_number = ? AND owner_user_id = ?`,
    [n, userId],
  );
  return row ?? null;
}

function statusBadge(status: string): SafeHtml {
  const labels: Record<string, string> = {
    draft: "draft",
    pending: "proposed",
    published: "published",
    rejected: "rejected",
    withdrawn: "withdrawn",
  };
  const label = labels[status] ?? status;
  return h`<span class="status-badge status-${status}">${label}</span>`;
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
  const esRaw = scrub("entry_status");
  return {
    title: scrub("title"),
    prompt: scrub("prompt"),
    output: scrub("output"),
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
): { ok: true; tags: string[]; date: string | null } | { ok: false; error: string } {
  if (!values.title) return { ok: false, error: "Title is required." };
  if (values.title.length > LIMITS.title) return { ok: false, error: `Title too long (max ${LIMITS.title}).` };
  if (!values.prompt) return { ok: false, error: "Prompt is required." };
  if (values.prompt.length > LIMITS.prompt) return { ok: false, error: `Prompt too long (max ${LIMITS.prompt}).` };
  if (!values.output) return { ok: false, error: "Model output is required." };
  if (values.output.length > LIMITS.output) return { ok: false, error: `Output too long (max ${LIMITS.output}).` };
  if (!values.ai_model) return { ok: false, error: "AI model is required." };
  if (values.ai_model.length > LIMITS.ai_model) return { ok: false, error: `Model name too long (max ${LIMITS.ai_model}).` };
  if (!values.category || !isValidCategory(values.category)) return { ok: false, error: "Pick a valid category." };
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

  return { ok: true, tags: tagResult.tags, date: dateResult.value };
}

function renderEditForm(opts: {
  eahId: string;
  values: EditFormValues;
  csrf: string;
  error: string | null;
  username: string;
}): SafeHtml {
  const { eahId, values, csrf, error, username } = opts;
  const action = `/my/submissions/${eahId}/edit`;
  const proposeAction = `/my/submissions/${eahId}/propose`;

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

      <label for="category">Category</label>
      <select id="category" name="category" required>
        <option value="">-- choose one --</option>
        ${categoryOptions}
      </select>

      <label for="prompt">Prompt</label>
      <textarea id="prompt" name="prompt" rows="6" maxlength="${LIMITS.prompt}"
                required data-char-count="prompt-count">${values.prompt}</textarea>
      <small id="prompt-count" class="char-count">0 / ${LIMITS.prompt} chars</small>

      <label for="output">Model output</label>
      <textarea id="output" name="output" rows="10" maxlength="${LIMITS.output}"
                required data-char-count="output-count">${values.output}</textarea>
      <small id="output-count" class="char-count">0 / ${LIMITS.output} chars</small>

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
          Allow EAH staff to edit this submission. You can always edit it
          yourself regardless of this setting.
        </label>
      </p>

      <label for="entry_status">Entry status</label>
      <select id="entry_status" name="entry_status">
        <option value="active" ${values.entry_status === "active" ? raw("selected") : raw("")}>Active (still reproduces)</option>
        <option value="patched" ${values.entry_status === "patched" ? raw("selected") : raw("")}>Patched (model updated)</option>
      </select>

      <div class="form-actions">
        <button type="submit">Save draft</button>
      </div>
    </form>

    <form method="post" action="${proposeAction}" class="form-actions">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit">Propose for review</button>
    </form>
  `;
}

function renderReadOnly(row: SubmissionRow, eahId: string, csrf: string, note: SafeHtml): SafeHtml {
  const discussionLink = h`<a href="/my/submissions/${eahId}/discussion">discussion</a>`;
  const historyLink = h`<a href="/my/submissions/${eahId}/history">history</a>`;

  return h`
    ${note}
    <dl>
      <dt>Title</dt><dd>${row.title ?? "(none)"}</dd>
      <dt>Status</dt><dd>${statusBadge(row.status)}</dd>
      <dt>AI model</dt><dd>${row.ai_model}</dd>
      <dt>Category</dt><dd>${row.category}</dd>
      <dt>Prompt</dt><dd><pre class="note">${row.prompt}</pre></dd>
      <dt>Output</dt><dd><pre class="note">${row.output}</pre></dd>
      ${row.summary ? h`<dt>Summary</dt><dd>${row.summary}</dd>` : raw("")}
      ${row.notes ? h`<dt>Notes</dt><dd>${row.notes}</dd>` : raw("")}
      ${row.hallucination_date ? h`<dt>Date</dt><dd>${row.hallucination_date}</dd>` : raw("")}
    </dl>
    <p>${discussionLink} · ${historyLink}</p>
  `;
}

// ─── mySubmissions ────────────────────────────────────────────────────────────

export const mySubmissions: RouteHandler = async (req, ctx) => {
  if (!ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  const rows = await query<{
    id: number;
    eah_number: number;
    title: string | null;
    ai_model: string;
    status: string;
    submitted_at: Date;
  }>(
    // Withdrawn submissions free their A-number, so they have no working
    // /my/submissions/:eahId links — exclude them from the list entirely.
    `SELECT id, eah_number, title, ai_model, status, submitted_at
       FROM submissions
      WHERE owner_user_id = ? AND status != 'withdrawn'
      ORDER BY submitted_at DESC`,
    [ctx.user.userId],
  );

  const { token } = tokenForRequest(req);

  const tableRows = rows.map((row) => {
    const eahId = formatEahId(row.eah_number);
    const submittedDate = new Date(row.submitted_at).toISOString().slice(0, 10);

    let actions: SafeHtml;
    if (row.status === "draft") {
      actions = h`<a href="/my/submissions/${eahId}/edit">edit</a> ·
        <a href="/my/submissions/${eahId}/discussion">discussion</a> ·
        <a href="/my/submissions/${eahId}/history">history</a> ·
        <form class="inline-form" method="post" action="/my/submissions/${eahId}/propose">
          <input type="hidden" name="_csrf" value="${token}">
          <button class="linkbutton" type="submit">propose for review</button>
        </form> ·
        <form class="inline-form" method="post" action="/my/submissions/${eahId}/withdraw">
          <input type="hidden" name="_csrf" value="${token}">
          <button class="linkbutton" type="submit">withdraw</button>
        </form>`;
    } else if (row.status === "pending") {
      actions = h`<a href="/my/submissions/${eahId}/discussion">discussion</a> ·
        <a href="/my/submissions/${eahId}/history">history</a> ·
        <form class="inline-form" method="post" action="/my/submissions/${eahId}/withdraw">
          <input type="hidden" name="_csrf" value="${token}">
          <button class="linkbutton" type="submit">withdraw</button>
        </form>`;
    } else if (row.status === "published") {
      actions = h`<a href="/e/${eahId}">view</a>`;
    } else {
      // rejected — the A-number was freed, so there are no working detail
      // links left. Show the status only.
      actions = h`<span class="muted">—</span>`;
    }

    return h`
      <tr>
        <td>${eahId ? h`<code>${eahId}</code>` : h`<span class="muted">—</span>`}</td>
        <td>${row.title ?? "(untitled)"}</td>
        <td>${row.ai_model}</td>
        <td>${statusBadge(row.status)}</td>
        <td>${submittedDate}</td>
        <td>${actions}</td>
      </tr>
    `;
  });

  const emptyNote = rows.length === 0
    ? h`<p>No submissions yet. <a href="/submit">Submit one</a>.</p>`
    : raw("");

  const body = h`
    ${emptyNote}
    ${rows.length > 0 ? h`
      <table class="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Title</th>
            <th>Model</th>
            <th>Status</th>
            <th>Submitted</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <p><a href="/submit">Submit another</a></p>
    ` : raw("")}
  `;

  return pageResponse(req, {
    title: "My submissions · EAH",
    heading: "My submissions",
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
      title: "Not found · EAH",
      heading: "Not found",
      body: h`<p>Submission not found. <a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 404 });
  }

  const eahId = formatEahId(row.eah_number);
  const { token, setCookie } = tokenForRequest(req);

  if (row.status === "draft") {
    // Load current tags for the form
    const tagRows = await query<{ name: string }>(
      `SELECT t.name FROM tags t
         JOIN submission_tags st ON st.tag_id = t.id
        WHERE st.submission_id = ?
        ORDER BY t.name ASC`,
      [row.id],
    );

    const values: EditFormValues = {
      title: row.title ?? "",
      prompt: row.prompt,
      output: row.output,
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
    const savedFlash = saved
      ? h`<div class="flash-success">Saved.</div>`
      : raw("");

    const subnav = h`<p class="subnav">
      <a href="/my/submissions">← my submissions</a> ·
      <a href="/my/submissions/${eahId}/discussion">discussion</a> ·
      <a href="/my/submissions/${eahId}/history">history</a>
    </p>`;

    const withdrawForm = h`
      <form class="inline-form" method="post" action="/my/submissions/${eahId}/withdraw">
        <input type="hidden" name="_csrf" value="${token}">
        <button class="linkbutton danger" type="submit">withdraw</button>
      </form>
    `;

    const formHtml = renderEditForm({ eahId, values, csrf: token, error: null, username: ctx.user.username });

    const body = h`
      ${savedFlash}
      <p><strong>${eahId}</strong> · ${statusBadge(row.status)} · ${withdrawForm}</p>
      ${formHtml}
    `;

    return pageResponse(req, {
      title: `Edit ${eahId} · EAH`,
      heading: `Edit ${eahId}`,
      body,
      user: ctx.user,
      subnav,
    }, { setCookie });
  }

  if (row.status === "pending") {
    const note = h`
      <div class="info-banner">
        <p>This submission is currently proposed for review and cannot be edited.
           <a href="/my/submissions/${eahId}/discussion">View discussion</a>.</p>
        <p>To make edits, withdraw it first:</p>
        <form method="post" action="/my/submissions/${eahId}/withdraw">
          <input type="hidden" name="_csrf" value="${token}">
          <button type="submit">Withdraw</button>
        </form>
      </div>
    `;
    const body = renderReadOnly(row, eahId, token, note);
    return pageResponse(req, {
      title: `${eahId} (proposed) · EAH`,
      heading: eahId,
      body,
      user: ctx.user,
    }, { setCookie });
  }

  // published / rejected / withdrawn — read-only
  const viewLink = row.status === "published"
    ? h`<a href="/e/${eahId}">View public entry</a>`
    : raw("");

  const note = h`
    <p>${statusBadge(row.status)} ${viewLink}</p>
  `;
  const body = renderReadOnly(row, eahId, token, note);
  return pageResponse(req, {
    title: `${eahId} · EAH`,
    heading: eahId,
    body,
    user: ctx.user,
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
      title: "Error · EAH",
      heading: "Error",
      body: h`<p>Form too large.</p>`,
      user: ctx.user,
    }, { status: 413 });
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    return pageResponse(req, {
      title: "Forbidden · EAH",
      heading: "Forbidden",
      body: h`<p>Invalid CSRF token. Please reload and try again.</p>`,
      user: ctx.user,
    }, { status: 403 });
  }

  const row = await fetchOwned(eahIdStr, ctx.user.userId);
  if (!row || row.status !== "draft") {
    return pageResponse(req, {
      title: "Not found · EAH",
      heading: "Not found",
      body: h`<p>Draft not found. <a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 404 });
  }

  const values = readEditForm(form);
  const v = validateEditForm(values);

  if (!v.ok) {
    const { token, setCookie } = tokenForRequest(req);
    const eahId = formatEahId(row.eah_number);
    const formHtml = renderEditForm({ eahId, values, csrf: token, error: v.error, username: ctx.user.username });
    const body = h`
      <p><strong>${eahId}</strong> · ${statusBadge(row.status)}</p>
      ${formHtml}
    `;
    return pageResponse(req, {
      title: `Edit ${eahId} · EAH`,
      heading: `Edit ${eahId}`,
      body,
      user: ctx.user,
    }, { status: 400, setCookie });
  }

  const eahId = formatEahId(row.eah_number);
  const userId = ctx.user.userId;

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
  };

  const newValues: TrackedValues = {
    title: values.title || null,
    prompt: values.prompt,
    output: values.output,
    ai_model: values.ai_model,
    summary: values.summary || null,
    notes: values.notes || null,
    shared_chat_url: values.shared_chat_url || null,
    category: values.category,
    hallucination_date: v.date,
    entry_status: values.entry_status,
    tags: newTagString || null,
  };

  try {
    await transaction(async (tx) => {
      // Record diffs before updating so currentValues is still accurate.
      await recordVersionDiffs(tx, row.id, userId, currentValues, newValues);

      await tx.execute(
        `UPDATE submissions
            SET title = ?, prompt = ?, output = ?, ai_model = ?, summary = ?, notes = ?,
                shared_chat_url = ?, category = ?,
                hallucination_date = ?, entry_status = ?, anon_public = ?, allow_author_edits = ?
          WHERE id = ?`,
        [
          values.title || null,
          values.prompt,
          values.output,
          values.ai_model,
          values.summary || null,
          values.notes || null,
          values.shared_chat_url || null,
          values.category,
          v.date,
          values.entry_status,
          values.anon_public ? 1 : 0,
          values.allow_author_edits ? 1 : 0,
          row.id,
        ],
      );

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
      title: "Error · EAH",
      heading: "Error",
      body: h`<p>Could not save changes. Please try again.</p>`,
      user: ctx.user,
    }, { status: 500 });
  }

  return new Response(null, {
    status: 303,
    headers: { Location: `/my/submissions/${eahId}/edit?saved=1` },
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
      title: "Forbidden · EAH",
      heading: "Forbidden",
      body: h`<p>Invalid CSRF token.</p>`,
      user: ctx.user,
    }, { status: 403 });
  }

  // Proposing a draft into the review queue is a form of submitting, so a
  // timed-out user can't do it either. They can still edit/withdraw drafts.
  if (isSuspended(ctx.user)) {
    return pageResponse(req, {
      title: "Timed out · EAH",
      heading: "You're timed out",
      body: h`<p>You can't propose a submission for review while your account is
        timed out${ctx.user.suspendedReason ? h`: <em>${ctx.user.suspendedReason}</em>` : raw("")}.
        You can still edit or withdraw your drafts.</p>
        <p><a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 403 });
  }

  const row = await fetchOwned(eahIdStr, ctx.user.userId);
  if (!row || row.status !== "draft") {
    return new Response(null, { status: 404 });
  }

  const username = ctx.user.username;

  try {
    await transaction(async (tx) => {
      await tx.execute(
        "UPDATE submissions SET status = 'pending' WHERE id = ? AND owner_user_id = ? AND status = 'draft'",
        [row.id, ctx.user!.userId],
      );
      await tx.execute(
        `INSERT INTO submission_messages (submission_id, sender_type, body) VALUES (?, 'system', ?)`,
        [row.id, `Submission proposed for review by ${username}.`],
      );
    });
  } catch (err) {
    console.error("propose failed", err);
    return pageResponse(req, {
      title: "Error · EAH",
      heading: "Error",
      body: h`<p>Could not propose submission. Please try again.</p>`,
      user: ctx.user,
    }, { status: 500 });
  }

  return new Response(null, { status: 303, headers: { Location: "/my/submissions" } });
};

// ─── myWithdraw ───────────────────────────────────────────────────────────────

export const myWithdraw: RouteHandler = async (req, ctx) => {
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
      title: "Forbidden · EAH",
      heading: "Forbidden",
      body: h`<p>Invalid CSRF token.</p>`,
      user: ctx.user,
    }, { status: 403 });
  }

  const row = await fetchOwned(eahIdStr, ctx.user.userId);
  if (!row || (row.status !== "draft" && row.status !== "pending")) {
    return new Response(null, { status: 404 });
  }

  const eahId = formatEahId(row.eah_number);

  if (form.get("confirm") !== "1") {
    const confirmBody = h`
      <p>Withdraw <strong>${eahId}</strong>? This will remove it from review and move it out of your drafts.</p>
      <form method="post" action="/my/submissions/${eahId}/withdraw">
        <input type="hidden" name="_csrf" value="${form.get("_csrf") ?? ""}">
        <input type="hidden" name="confirm" value="1">
        <button type="submit" class="btn-danger">Withdraw submission</button>
      </form>
      <p><a href="/my/submissions/${eahId}/edit">Cancel</a></p>
    `;
    return pageResponse(req, {
      title: `Withdraw ${eahId} · EAH`,
      heading: `Withdraw ${eahId}`,
      body: confirmBody,
      user: ctx.user,
    });
  }

  const username = ctx.user.username;

  try {
    await transaction(async (tx) => {
      await tx.execute(
        "UPDATE submissions SET status = 'withdrawn' WHERE id = ?",
        [row.id],
      );
      await freeEahNumber(tx, row.id);
      await tx.execute(
        `INSERT INTO submission_messages (submission_id, sender_type, body) VALUES (?, 'system', ?)`,
        [row.id, `Submission withdrawn by ${username}.`],
      );
    });
  } catch (err) {
    console.error("withdraw failed", err);
    return pageResponse(req, {
      title: "Error · EAH",
      heading: "Error",
      body: h`<p>Could not withdraw submission. Please try again.</p>`,
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
      title: "Not found · EAH",
      heading: "Not found",
      body: h`<p>Submission not found. <a href="/my/submissions">My submissions</a></p>`,
      user: ctx.user,
    }, { status: 404 });
  }

  const eahId = formatEahId(row.eah_number);

  const versionRows = await query<{
    id: number;
    version_num: number;
    changed_by: number | null;
    changed_at: Date;
    field_name: string;
    old_value: string | null;
    new_value: string | null;
    changed_by_username: string | null;
  }>(
    `SELECT v.id, v.version_num, v.changed_by, v.changed_at,
            v.field_name, v.old_value, v.new_value,
            u.username AS changed_by_username
       FROM submission_versions v
       LEFT JOIN users u ON u.id = v.changed_by
      WHERE v.submission_id = ?
      ORDER BY v.version_num ASC, v.id ASC`,
    [row.id],
  );

  let historyHtml: SafeHtml;

  if (versionRows.length === 0) {
    historyHtml = h`<p>No edits recorded yet.</p>`;
  } else {
    // Group by version_num.
    const groups = new Map<number, typeof versionRows>();
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
        const delPart = f.old_value !== null
          ? h`<del class="diff-del">${f.old_value}</del>`
          : raw("");
        const insPart = f.new_value !== null
          ? h`<ins class="diff-add">${f.new_value}</ins>`
          : raw("");
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

    historyHtml = h`${groupHtml}`;
  }

  const subnav = h`<p class="subnav">
    <a href="/my/submissions">← my submissions</a> ·
    <a href="/my/submissions/${eahId}/edit">edit</a> ·
    <a href="/my/submissions/${eahId}/discussion">discussion</a>
  </p>`;

  const body = h`
    <p><strong>${eahId}</strong> · ${statusBadge(row.status)} · ${row.title ?? "(untitled)"}</p>
    ${historyHtml}
  `;

  return pageResponse(req, {
    title: `History ${eahId} · EAH`,
    heading: `Edit history — ${eahId}`,
    body,
    user: ctx.user,
    subnav,
  });
};
