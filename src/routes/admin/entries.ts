/**
 * Direct entry management for staff — bypasses the draft workflow.
 *
 *   GET  /admin/entries/new           — form to add a new published entry directly
 *   POST /admin/entries/new           — create it (status='published', allocates A-number)
 *   GET  /admin/entries/:eahId/edit   — edit an existing entry by its A-number
 *   POST /admin/entries/:eahId/edit   — save edits
 *   POST /admin/entries/:eahId/status — flip entry_status between 'active' and 'patched'
 */
import { randomBytes, createHash } from "node:crypto";
import { h, raw, type SafeHtml } from "../../html.ts";
import { layout } from "../../layout.ts";
import { execute, query, queryOne, transaction } from "../../db.ts";
import { tokenForRequest, verifyCsrf } from "../../csrf.ts";
import { CATEGORIES, categoryLabel, isValidCategory } from "../../categories.ts";
import { config } from "../../config.ts";
import { allocateEahNumber, formatEahId, parseEahId } from "../../eah-id.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteContext } from "../types.ts";

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

interface FormValues {
  title: string;
  prompt: string;
  output: string;
  ai_model: string;
  category: string;
  tags: string;
  summary: string;
  notes: string;
  shared_chat_url: string;
  author_name: string;
  hallucination_date: string;
  entry_status: "active" | "patched";
  verified_hits: string;
  verified_total: string;
}

function emptyForm(): FormValues {
  return {
    title: "", prompt: "", output: "", ai_model: "", category: "", tags: "",
    summary: "", notes: "", shared_chat_url: "", author_name: "",
    hallucination_date: "", entry_status: "active",
    verified_hits: "", verified_total: "",
  };
}

function authRedirect(): Response {
  return new Response(null, { status: 303, headers: { Location: "/admin/login" } });
}

function badRequest(message: string, status = 400): Response {
  const body = layout({
    title: "Bad request",
    heading: "Bad request",
    body: h`<p>${message} <a href="/admin/queue">Back to admin queue</a>.</p>`,
  });
  return htmlResponse(body, { status });
}

function renderForm(opts: {
  mode: "new" | "edit";
  eahId?: string;
  values: FormValues;
  csrf: string;
  error: string | null;
}): SafeHtml {
  const { mode, eahId, values, csrf, error } = opts;
  const action = mode === "new" ? "/admin/entries/new" : `/admin/entries/${eahId}/edit`;

  const errBlock = error
    ? h`<div class="form-error" role="alert"><strong>Error:</strong> ${error}</div>`
    : h``;

  const categoryOptions = h`${CATEGORIES.map(
    (c) => h`<option value="${c.key}" ${values.category === c.key ? raw('selected') : raw('')}>${c.label}</option>`,
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
      <textarea id="prompt" name="prompt" rows="6" maxlength="${LIMITS.prompt}" required>${values.prompt}</textarea>

      <label for="output">Model output</label>
      <textarea id="output" name="output" rows="10" maxlength="${LIMITS.output}" required>${values.output}</textarea>

      <label for="summary">Summary</label>
      <textarea id="summary" name="summary" rows="3" maxlength="${LIMITS.summary}">${values.summary}</textarea>

      <label for="notes">Notes</label>
      <textarea id="notes" name="notes" rows="4" maxlength="${LIMITS.notes}">${values.notes}</textarea>

      <label for="hallucination_date">Date of hallucination (YYYY-MM-DD, optional)</label>
      <input id="hallucination_date" name="hallucination_date" type="date" value="${values.hallucination_date}">

      <label for="shared_chat_url">Shared chat URL (optional)</label>
      <input id="shared_chat_url" name="shared_chat_url" type="url" maxlength="${LIMITS.shared_chat_url}"
             value="${values.shared_chat_url}">

      <label for="tags">Tags (comma-separated)</label>
      <input id="tags" name="tags" type="text" maxlength="${LIMITS.tags}" value="${values.tags}">

      <label for="author_name">Author name (optional)</label>
      <input id="author_name" name="author_name" type="text" maxlength="${LIMITS.author_name}"
             value="${values.author_name}">

      <label for="entry_status">Entry status</label>
      <select id="entry_status" name="entry_status">
        <option value="active" ${values.entry_status === "active" ? raw('selected') : raw('')}>Active (still reproduces)</option>
        <option value="patched" ${values.entry_status === "patched" ? raw('selected') : raw('')}>Patched (model updated, no longer triggers)</option>
      </select>

      <label for="verified_hits">Staff verification</label>
      <p>
        Prompt reproduced
        <input type="number" id="verified_hits" name="verified_hits" min="0" max="999"
               value="${values.verified_hits}" style="width:5em">
        out of
        <input type="number" name="verified_total" min="0" max="999"
               value="${values.verified_total}" style="width:5em">
        attempts.
      </p>

      <button type="submit">${mode === "new" ? "Create entry" : "Save changes"}</button>
    </form>
  `;
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

function parseVerification(hitsStr: string, totalStr: string):
  | { ok: true; hits: number | null; total: number | null }
  | { ok: false; error: string }
{
  const parse = (s: string): number | null => {
    const t = s.trim();
    if (t === "") return null;
    if (!/^\d{1,3}$/.test(t)) return NaN; // signal invalid
    const n = parseInt(t, 10);
    return n >= 0 && n <= 999 ? n : NaN;
  };
  const hits = parse(hitsStr);
  const total = parse(totalStr);
  if (hits !== null && Number.isNaN(hits)) return { ok: false, error: "Verified hits must be 0-999." };
  if (total !== null && Number.isNaN(total)) return { ok: false, error: "Verified total must be 0-999." };
  if (hits !== null && total === null) return { ok: false, error: "Provide a total if you give a hit count." };
  if (hits !== null && total !== null && total < hits) return { ok: false, error: "Total must be ≥ hits." };
  return { ok: true, hits, total };
}

function readForm(form: URLSearchParams): FormValues {
  const scrub = (k: string) => sanitizeText(form.get(k) ?? "").trim();
  const status = scrub("entry_status");
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
    author_name: scrub("author_name"),
    hallucination_date: scrub("hallucination_date"),
    entry_status: status === "patched" ? "patched" : "active",
    verified_hits: scrub("verified_hits"),
    verified_total: scrub("verified_total"),
  };
}

function validate(values: FormValues): { ok: true; tags: string[]; date: string | null; hits: number | null; total: number | null } | { ok: false; error: string } {
  if (!values.title) return { ok: false, error: "Title is required." };
  if (values.title.length > LIMITS.title) return { ok: false, error: `Title too long (max ${LIMITS.title}).` };
  if (!values.prompt) return { ok: false, error: "Prompt is required." };
  if (!values.output) return { ok: false, error: "Output is required." };
  if (!values.ai_model) return { ok: false, error: "AI model is required." };
  if (!values.category || !isValidCategory(values.category)) return { ok: false, error: "Pick a valid category." };

  if (values.shared_chat_url.length > 0) {
    try {
      const u = new URL(values.shared_chat_url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      return { ok: false, error: "Shared chat URL must be a valid http(s) URL." };
    }
  }

  const tagResult = parseTags(values.tags);
  if (!tagResult.ok) return { ok: false, error: tagResult.error };

  const dateResult = parseDate(values.hallucination_date);
  if (!dateResult.ok) return { ok: false, error: dateResult.error };

  const vResult = parseVerification(values.verified_hits, values.verified_total);
  if (!vResult.ok) return { ok: false, error: vResult.error };

  return { ok: true, tags: tagResult.tags, date: dateResult.value, hits: vResult.hits, total: vResult.total };
}

async function syncTags(tx: any, submissionId: number, tags: string[]): Promise<void> {
  // Replace the tag set. Simplest correct path: clear and re-insert.
  await tx.execute("DELETE FROM submission_tags WHERE submission_id = ?", [submissionId]);
  for (const tag of tags) {
    await tx.execute("INSERT IGNORE INTO tags (name) VALUES (?)", [tag]);
    const row = await tx.queryOne("SELECT id FROM tags WHERE name = ?", [tag]);
    if (!row) throw new Error(`tag missing after insert: ${tag}`);
    await tx.execute(
      "INSERT IGNORE INTO submission_tags (submission_id, tag_id) VALUES (?, ?)",
      [submissionId, row.id],
    );
  }
}

// ─── new entry ──────────────────────────────────────────────────────────────

export async function getNewEntry(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();
  const { token, setCookie } = tokenForRequest(req);
  const body = renderForm({ mode: "new", values: emptyForm(), csrf: token, error: null });
  return htmlResponse(
    layout({ title: "Add entry · EAH admin", heading: "Add a new published entry", body, admin: { username: ctx.admin.username, csrfToken: token } }),
    { setCookie },
  );
}

export async function postNewEntry(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 128 * 1024);
  } catch {
    return badRequest("Form too large.", 413);
  }
  if (!verifyCsrf(req, form.get("_csrf"))) return badRequest("Invalid CSRF token.", 403);

  const values = readForm(form);
  const v = validate(values);
  if (!v.ok) {
    const { token, setCookie } = tokenForRequest(req);
    const body = renderForm({ mode: "new", values, csrf: token, error: v.error });
    return htmlResponse(
      layout({ title: "Add entry · EAH admin", heading: "Add a new published entry", body, admin: { username: ctx.admin.username, csrfToken: token } }),
      { status: 400, setCookie },
    );
  }

  // We mint a public_id (kept for back-compat with old URLs) and a
  // tracking_hash that nobody knows — staff entries don't go through /track
  // because there's no submitter to track.
  const publicId = randomBytes(8).toString("base64url").slice(0, 10);
  const trackingHash = createHash("sha256").update(randomBytes(32)).digest();
  const ipHash = createHash("sha256").update(`${config.sessionSecret}:admin-direct`).digest();

  let eahNumber: number;
  try {
    eahNumber = await transaction(async (tx) => {
      const n = await allocateEahNumber(tx);
      const ins = await tx.execute(
        `INSERT INTO submissions
          (public_id, eah_number, title, tracking_hash, prompt, output, ai_model, summary, notes,
           shared_chat_url, category, author_name, submitted_at, status, ip_hash,
           hallucination_date, allow_author_edits, entry_status,
           reviewed_by, reviewed_at, verified_hits, verified_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'published', ?, ?, 0, ?, ?, NOW(), ?, ?)`,
        [
          publicId,
          n,
          values.title,
          trackingHash,
          values.prompt,
          values.output,
          values.ai_model,
          values.summary.length > 0 ? values.summary : null,
          values.notes.length > 0 ? values.notes : null,
          values.shared_chat_url.length > 0 ? values.shared_chat_url : null,
          values.category,
          values.author_name.length > 0 ? values.author_name : null,
          ipHash,
          v.date,
          values.entry_status,
          ctx.admin!.adminId,
          v.hits,
          v.total,
        ],
      );
      const submissionId = ins.insertId;
      if (!submissionId) throw new Error("insert returned no id");
      await syncTags(tx, submissionId, v.tags);
      return n;
    });
  } catch (err) {
    console.error("admin direct-add failed", err);
    return badRequest("Could not save the entry.", 500);
  }

  const eahId = formatEahId(eahNumber);
  return new Response(null, { status: 303, headers: { Location: `/e/${eahId}` } });
}

// ─── edit entry ─────────────────────────────────────────────────────────────

async function loadByEahId(eahIdParam: string): Promise<{
  id: number;
  eah_number: number;
  title: string | null;
  prompt: string;
  output: string;
  ai_model: string;
  summary: string | null;
  notes: string | null;
  shared_chat_url: string | null;
  category: string;
  author_name: string | null;
  hallucination_date: string | null;
  entry_status: "active" | "patched";
  verified_hits: number | null;
  verified_total: number | null;
  status: string;
} | null> {
  const n = parseEahId(eahIdParam);
  if (n === null) return null;
  const row = await queryOne<any>(
    `SELECT id, eah_number, title, prompt, output, ai_model, summary, notes, shared_chat_url,
            category, author_name, hallucination_date, entry_status, verified_hits, verified_total, status
       FROM submissions
       WHERE eah_number = ?`,
    [n],
  );
  return row ?? null;
}

export async function getEditEntry(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();
  const row = await loadByEahId(ctx.params.eahId ?? "");
  if (!row) return badRequest("No entry with that A-number.", 404);

  const tagRows = await query<{ name: string }>(
    `SELECT t.name FROM submission_tags st JOIN tags t ON t.id = st.tag_id
     WHERE st.submission_id = ? ORDER BY t.name ASC`,
    [row.id],
  );

  const values: FormValues = {
    title: row.title ?? "",
    prompt: row.prompt,
    output: row.output,
    ai_model: row.ai_model,
    category: row.category,
    tags: tagRows.map((t) => t.name).join(", "),
    summary: row.summary ?? "",
    notes: row.notes ?? "",
    shared_chat_url: row.shared_chat_url ?? "",
    author_name: row.author_name ?? "",
    hallucination_date: row.hallucination_date ?? "",
    entry_status: row.entry_status,
    verified_hits: row.verified_hits !== null ? String(row.verified_hits) : "",
    verified_total: row.verified_total !== null ? String(row.verified_total) : "",
  };

  const eahId = formatEahId(row.eah_number);
  const { token, setCookie } = tokenForRequest(req);
  const body = renderForm({ mode: "edit", eahId, values, csrf: token, error: null });
  return htmlResponse(
    layout({
      title: `Edit ${eahId} · EAH admin`,
      heading: `Edit ${eahId}`,
      body,
      admin: { username: ctx.admin.username, csrfToken: token },
    }),
    { setCookie },
  );
}

export async function postEditEntry(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();

  const eahIdParam = ctx.params.eahId ?? "";
  const row = await loadByEahId(eahIdParam);
  if (!row) return badRequest("No entry with that A-number.", 404);

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 128 * 1024);
  } catch {
    return badRequest("Form too large.", 413);
  }
  if (!verifyCsrf(req, form.get("_csrf"))) return badRequest("Invalid CSRF token.", 403);

  const values = readForm(form);
  const v = validate(values);
  if (!v.ok) {
    const { token, setCookie } = tokenForRequest(req);
    const body = renderForm({ mode: "edit", eahId: formatEahId(row.eah_number), values, csrf: token, error: v.error });
    return htmlResponse(
      layout({
        title: `Edit ${formatEahId(row.eah_number)} · EAH admin`,
        heading: `Edit ${formatEahId(row.eah_number)}`,
        body,
        admin: { username: ctx.admin.username, csrfToken: token },
      }),
      { status: 400, setCookie },
    );
  }

  try {
    await transaction(async (tx) => {
      await tx.execute(
        `UPDATE submissions
            SET title = ?, prompt = ?, output = ?, ai_model = ?, summary = ?, notes = ?,
                shared_chat_url = ?, category = ?, author_name = ?, hallucination_date = ?,
                entry_status = ?, verified_hits = ?, verified_total = ?
          WHERE id = ?`,
        [
          values.title,
          values.prompt,
          values.output,
          values.ai_model,
          values.summary.length > 0 ? values.summary : null,
          values.notes.length > 0 ? values.notes : null,
          values.shared_chat_url.length > 0 ? values.shared_chat_url : null,
          values.category,
          values.author_name.length > 0 ? values.author_name : null,
          v.date,
          values.entry_status,
          v.hits,
          v.total,
          row.id,
        ],
      );
      await syncTags(tx, row.id, v.tags);
    });
  } catch (err) {
    console.error("admin entry edit failed", err);
    return badRequest("Could not save changes.", 500);
  }

  return new Response(null, { status: 303, headers: { Location: `/e/${formatEahId(row.eah_number)}` } });
}

// ─── flip active/patched ────────────────────────────────────────────────────

export async function postEntryStatus(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 8 * 1024);
  } catch {
    return badRequest("Form too large.", 413);
  }
  if (!verifyCsrf(req, form.get("_csrf"))) return badRequest("Invalid CSRF token.", 403);

  const n = parseEahId(ctx.params.eahId ?? "");
  if (n === null) return badRequest("Invalid A-number.", 404);

  const next = form.get("entry_status");
  if (next !== "active" && next !== "patched") {
    return badRequest("Invalid entry status.");
  }

  const result = await execute(
    "UPDATE submissions SET entry_status = ? WHERE eah_number = ? AND status = 'published'",
    [next, n],
  );
  if (result.affectedRows === 0) return badRequest("Entry not found or not published.", 404);

  return new Response(null, {
    status: 303,
    headers: { Location: `/e/${formatEahId(n)}` },
  });
}

// Suppress unused-import warning at the bottom (categoryLabel is part of the
// public categories module API, exported here only so future helpers can use it).
void categoryLabel;
