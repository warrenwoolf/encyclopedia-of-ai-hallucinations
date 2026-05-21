/**
 * GET /submit — show the submission form.
 * POST /submit — validate, rate-limit, allocate the EAH number, insert as
 * `pending`, and return a one-time tracking code to the user.
 */
import { randomBytes, createHash } from "node:crypto";
import { h, raw, type SafeHtml } from "../html.ts";
import { layout } from "../layout.ts";
import { execute, transaction, queryOne } from "../db.ts";
import { tokenForRequest, verifyCsrf } from "../csrf.ts";
import { check as rateCheck } from "../ratelimit.ts";
import { CATEGORIES, isValidCategory } from "../categories.ts";
import { config } from "../config.ts";
import { sendSubmissionReceived } from "../email.ts";
import { allocateEahNumber, formatEahId } from "../eah-id.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteHandler } from "./types.ts";

const LIMITS = {
  title: 200,
  prompt: 8000,
  output: 32000,
  ai_model: 120,
  summary: 2000,
  notes: 4000,
  shared_chat_url: 2048,
  author_name: 80,
  submitter_email: 254,
  tags: 600, // bounding the raw tags input
};

/** OEIS-style cap on simultaneous drafts per submitter email. */
const MAX_PENDING_PER_EMAIL = 4;

/** Pragmatic email format check. Not RFC-strict; rejects obvious garbage. */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,63}$/;

/** Pragmatic ISO-8601 date check, in the past or today. */
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
  submitter_email: string;
  hallucination_date: string;
  allow_author_edits: boolean;
}

function emptyForm(): FormValues {
  return {
    title: "", prompt: "", output: "", ai_model: "", category: "", tags: "",
    summary: "", notes: "", shared_chat_url: "", author_name: "",
    submitter_email: "", hallucination_date: "", allow_author_edits: false,
  };
}

function renderForm(opts: {
  values: FormValues;
  csrf: string;
  error: string | null;
}): SafeHtml {
  const { values, csrf, error } = opts;
  const errBlock = error
    ? h`<div class="form-error" role="alert"><strong>Error:</strong> ${error}</div>`
    : h``;

  const categoryOptions = h`${CATEGORIES.map(
    (c) => h`<option value="${c.key}" ${values.category === c.key ? raw('selected') : raw('')}>${c.label}</option>`,
  )}`;

  return h`
    ${errBlock}
    <form method="post" action="/submit" class="submit-form">
      <input type="hidden" name="_csrf" value="${csrf}">

      <label for="title">Title <small>(short descriptive name, e.g. "Strawberry R-count error")</small></label>
      <input id="title" name="title" type="text" maxlength="${LIMITS.title}"
             required value="${values.title}"
             placeholder="e.g. Savanna H-count error">

      <label for="ai_model">AI model <small>(or service + date if exact model unknown)</small></label>
      <input id="ai_model" name="ai_model" type="text" maxlength="${LIMITS.ai_model}"
             required value="${values.ai_model}"
             placeholder="e.g. GPT-4o, Claude 3.5 Sonnet, or 'Google AI Overview (accessed 2026-05-19)'">
      <p class="field-hint"><small>For products that don't expose their exact model
        (e.g. Google's AI Overview, Bing search summaries), write the service name
        and the date you accessed it.</small></p>

      <label for="category">Category</label>
      <select id="category" name="category" required>
        <option value="">-- choose one --</option>
        ${categoryOptions}
      </select>

      <label for="prompt">Prompt</label>
      <textarea id="prompt" name="prompt" rows="6" maxlength="${LIMITS.prompt}" required
                placeholder="the exact prompt you sent the model">${values.prompt}</textarea>

      <label for="output">Model output</label>
      <textarea id="output" name="output" rows="10" maxlength="${LIMITS.output}" required
                placeholder="the model's full response">${values.output}</textarea>

      <label for="summary">Summary <small>(optional, what's wrong about it)</small></label>
      <textarea id="summary" name="summary" rows="3" maxlength="${LIMITS.summary}"
                placeholder="optional: 1-2 sentences explaining what's hallucinated">${values.summary}</textarea>

      <label for="notes">Notes <small>(optional, anything else that doesn't fit elsewhere)</small></label>
      <textarea id="notes" name="notes" rows="4" maxlength="${LIMITS.notes}"
                placeholder="optional: reproduction steps, context about the conversation, related links, etc.">${values.notes}</textarea>

      <label for="hallucination_date">Date of hallucination <small>(optional; YYYY-MM-DD; leave blank if it was today)</small></label>
      <input id="hallucination_date" name="hallucination_date" type="date"
             value="${values.hallucination_date}">

      <label for="shared_chat_url">Shared chat URL <small>(optional, e.g. a chatgpt.com/share/... or claude.ai/share/... link)</small></label>
      <input id="shared_chat_url" name="shared_chat_url" type="url" maxlength="${LIMITS.shared_chat_url}"
             value="${values.shared_chat_url}" placeholder="https://...">
      <p class="field-hint"><small>If you have a shareable conversation link, paste it here. <strong>This will be public on the entry page.</strong></small></p>

      <label for="tags">Tags <small>(comma-separated; lowercase letters, digits, hyphens; max 10)</small></label>
      <input id="tags" name="tags" type="text" maxlength="${LIMITS.tags}"
             value="${values.tags}" placeholder="e.g. counting, strawberry, letter-r">

      <label for="author_name">Your name <small>(optional, shown publicly)</small></label>
      <input id="author_name" name="author_name" type="text" maxlength="${LIMITS.author_name}"
             value="${values.author_name}">

      <label for="submitter_email">Email <small>(optional, never shown publicly)</small></label>
      <input id="submitter_email" name="submitter_email" type="email" maxlength="${LIMITS.submitter_email}"
             value="${values.submitter_email}" placeholder="you@example.com" autocomplete="email">
      <p class="field-hint"><small>If you give us an email, we'll send a
        confirmation right away (with your tracking link, so you don't have to
        save the code by hand), notify you when a reviewer leaves a comment,
        and email you the decision when staff accept or reject your submission.
        You'll also be able to look up all your submissions at
        <a href="/lookup">/lookup</a>. See our <a href="/privacy">privacy
        policy</a> for what we do with this.</small></p>

      <p class="field-checkbox">
        <label class="checkbox-label">
          <input type="checkbox" name="allow_author_edits" value="1"
                 ${values.allow_author_edits ? raw('checked') : raw('')}>
          I'm OK with later staff-approved authors editing this entry on my behalf
          (e.g. to add reproduction notes, fix typos, or update the patched status).
        </label>
      </p>

      <button type="submit">Submit</button>
    </form>

    <p><small>Submissions are reviewed by staff before being published. You'll
    receive a tracking code (and an email, if you gave us one) to check status,
    chat with reviewers, or withdraw. While your submission is pending, you may
    have at most ${MAX_PENDING_PER_EMAIL} drafts open at once per email
    address.</small></p>
  `;
}

function showForm(req: Request, ctx: { admin: any }, opts: { values?: FormValues; error?: string | null; status?: number } = {}): Response {
  const { token, setCookie } = tokenForRequest(req);
  const body = renderForm({
    values: opts.values ?? emptyForm(),
    csrf: token,
    error: opts.error ?? null,
  });
  return htmlResponse(
    layout({ title: "Submit · EAH", heading: "Submit a hallucination", body, admin: ctx.admin }),
    { status: opts.status ?? 200, setCookie },
  );
}

function urlSafeId(bytes: number, length: number): string {
  // base64url has ~4 chars per 3 bytes. randomBytes(8) -> ~11 chars, slice to length.
  let out = "";
  while (out.length < length) {
    out += randomBytes(bytes).toString("base64url");
  }
  return out.slice(0, length);
}

async function generateUniquePublicId(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const candidate = urlSafeId(8, 10);
    const existing = await queryOne<{ id: number }>(
      "SELECT id FROM submissions WHERE public_id = ?",
      [candidate],
    );
    if (!existing) return candidate;
  }
  throw new Error("could not generate a unique public_id after several tries");
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
      return { ok: false, error: `Tag "${p}" must contain only lowercase letters, digits, and hyphens.` };
    }
    if (seen.has(p)) continue;
    seen.add(p);
    tags.push(p);
  }
  return { ok: true, tags };
}

/** YYYY-MM-DD in the past or today. Returns null for blank/invalid. */
function parseHallucinationDate(s: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = s.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  const m = DATE_RE.exec(trimmed);
  if (!m) return { ok: false, error: "Date of hallucination must be in YYYY-MM-DD format." };
  const y = parseInt(m[1]!, 10);
  const mo = parseInt(m[2]!, 10);
  const d = parseInt(m[3]!, 10);
  if (y < 2015 || y > 2100) return { ok: false, error: "Date of hallucination has an implausible year." };
  if (mo < 1 || mo > 12) return { ok: false, error: "Date of hallucination has an invalid month." };
  if (d < 1 || d > 31) return { ok: false, error: "Date of hallucination has an invalid day." };
  // Roundtrip through Date to catch e.g. Feb 30.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: "Date of hallucination is not a real calendar date." };
  }
  if (dt.getTime() > Date.now() + 24 * 3600 * 1000) {
    return { ok: false, error: "Date of hallucination can't be in the future." };
  }
  return { ok: true, value: trimmed };
}

export const submitGet: RouteHandler = (req, ctx) => {
  return showForm(req, ctx);
};

export const submitPost: RouteHandler = async (req, ctx) => {
  // Rate-limit first; cheap and avoids parsing huge bodies under attack.
  const rl = rateCheck("submit", ctx.ip);
  if (!rl.allowed) {
    const body = h`<p>Too many submissions. Please retry in ${rl.retryAfterSec ?? 60} seconds.</p>`;
    return htmlResponse(
      layout({ title: "Rate limited · EAH", heading: "Slow down", body, admin: ctx.admin }),
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } },
    );
  }

  let form: URLSearchParams;
  try {
    // Body cap a little bigger than sum of limits to allow for encoding overhead.
    form = await parseForm(req, 128 * 1024);
  } catch {
    return showForm(req, ctx, { error: "Submission too large.", status: 413 });
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    const body = h`<p>Invalid CSRF token. Reload the form and try again.</p>`;
    return htmlResponse(
      layout({ title: "Forbidden · EAH", heading: "Forbidden", body, admin: ctx.admin }),
      { status: 403 },
    );
  }

  const scrub = (k: string) => sanitizeText(form.get(k) ?? "").trim();
  const values: FormValues = {
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
    // Email is normalized to lowercase so /lookup can match without a
    // case-insensitive comparison and so duplicate-detection (if we ever add
    // it) works the obvious way.
    submitter_email: scrub("submitter_email").toLowerCase(),
    hallucination_date: scrub("hallucination_date"),
    allow_author_edits: form.get("allow_author_edits") === "1",
  };

  // Required + length checks.
  if (!values.title) return showForm(req, ctx, { values, error: "Title is required.", status: 400 });
  if (values.title.length > LIMITS.title)
    return showForm(req, ctx, { values, error: `Title is too long (max ${LIMITS.title} chars).`, status: 400 });

  if (!values.prompt) return showForm(req, ctx, { values, error: "Prompt is required.", status: 400 });
  if (values.prompt.length > LIMITS.prompt)
    return showForm(req, ctx, { values, error: `Prompt is too long (max ${LIMITS.prompt} chars).`, status: 400 });

  if (!values.output) return showForm(req, ctx, { values, error: "Model output is required.", status: 400 });
  if (values.output.length > LIMITS.output)
    return showForm(req, ctx, { values, error: `Output is too long (max ${LIMITS.output} chars).`, status: 400 });

  if (!values.ai_model) return showForm(req, ctx, { values, error: "AI model is required.", status: 400 });
  if (values.ai_model.length > LIMITS.ai_model)
    return showForm(req, ctx, { values, error: `AI model name is too long (max ${LIMITS.ai_model} chars).`, status: 400 });

  if (!values.category || !isValidCategory(values.category))
    return showForm(req, ctx, { values, error: "Please choose a valid category.", status: 400 });

  if (values.summary.length > LIMITS.summary)
    return showForm(req, ctx, { values, error: `Summary is too long (max ${LIMITS.summary} chars).`, status: 400 });

  if (values.notes.length > LIMITS.notes)
    return showForm(req, ctx, { values, error: `Notes are too long (max ${LIMITS.notes} chars).`, status: 400 });

  const dateResult = parseHallucinationDate(values.hallucination_date);
  if (!dateResult.ok) return showForm(req, ctx, { values, error: dateResult.error, status: 400 });
  const hallucinationDate = dateResult.value;

  if (values.shared_chat_url.length > 0) {
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(values.shared_chat_url);
    } catch {
      // invalid URL
    }
    if (!parsedUrl || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || values.shared_chat_url.length > LIMITS.shared_chat_url)
      return showForm(req, ctx, { values, error: "Shared chat URL must be a valid http(s) URL.", status: 400 });
  }

  if (values.author_name.length > LIMITS.author_name)
    return showForm(req, ctx, { values, error: `Author name is too long (max ${LIMITS.author_name} chars).`, status: 400 });

  if (values.submitter_email.length > 0) {
    if (values.submitter_email.length > LIMITS.submitter_email)
      return showForm(req, ctx, { values, error: `Email is too long (max ${LIMITS.submitter_email} chars).`, status: 400 });
    if (!EMAIL_RE.test(values.submitter_email))
      return showForm(req, ctx, { values, error: "Email address looks invalid. Leave it blank to skip.", status: 400 });
  }

  if (values.tags.length > LIMITS.tags)
    return showForm(req, ctx, { values, error: "Tags input is too long.", status: 400 });

  const tagResult = parseTags(values.tags);
  if (!tagResult.ok) return showForm(req, ctx, { values, error: tagResult.error, status: 400 });
  const tags = tagResult.tags;

  // OEIS-style draft cap: at most MAX_PENDING_PER_EMAIL pending submissions per
  // submitter email. Enforced ONLY when an email was provided (anonymous
  // submitters can't be linked across requests; the per-IP rate limit handles
  // that case).
  if (values.submitter_email.length > 0) {
    const pendingRow = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM submissions
        WHERE submitter_email = ? AND status = 'pending'`,
      [values.submitter_email],
    );
    const pending = Number(pendingRow?.n ?? 0);
    if (pending >= MAX_PENDING_PER_EMAIL) {
      return showForm(req, ctx, {
        values,
        error: `You already have ${pending} pending submissions for ${values.submitter_email}. ` +
          `EAH allows at most ${MAX_PENDING_PER_EMAIL} open drafts per email at a time — please ` +
          `wait for one to be accepted or rejected (or withdraw one at /lookup) before submitting another.`,
        status: 429,
      });
    }
  }

  // Generate IDs and hashes.
  const publicId = await generateUniquePublicId();
  const trackingCode = randomBytes(15).toString("base64url"); // 20 chars typical; ensure 24.
  const trackingCodeFull = (trackingCode + randomBytes(6).toString("base64url")).slice(0, 24);
  const trackingHash = createHash("sha256").update(trackingCodeFull).digest();
  const ipHash = createHash("sha256")
    .update(`${config.sessionSecret}:${ctx.ip}`)
    .digest();

  // notify_token holds the PLAINTEXT tracking code, but only if the submitter
  // gave us an email. This lets /lookup rebuild /track?code=… links later.
  // Submissions without an email keep the hash-only model intact.
  const hasEmail = values.submitter_email.length > 0;
  const submitterEmail = hasEmail ? values.submitter_email : null;
  const notifyToken = hasEmail ? trackingCodeFull : null;

  let eahNumber: number;
  // Insert in a single transaction so partial inserts don't leak orphan tag rows.
  try {
    eahNumber = await transaction(async (tx) => {
      // Allocate the A-number BEFORE the insert so we hold a row lock on
      // freed_eah_numbers (if used) for the whole transaction.
      const n = await allocateEahNumber(tx);

      const ins = await tx.execute(
        `INSERT INTO submissions
          (public_id, eah_number, title, tracking_hash, prompt, output, ai_model, summary, notes,
           shared_chat_url, category, author_name, submitted_at, status, ip_hash,
           submitter_email, notify_token, hallucination_date, allow_author_edits)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'pending', ?, ?, ?, ?, ?)`,
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
          submitterEmail,
          notifyToken,
          hallucinationDate,
          values.allow_author_edits ? 1 : 0,
        ],
      );
      const submissionId = ins.insertId;
      if (!submissionId) throw new Error("insert returned no id");

      for (const tag of tags) {
        await tx.execute("INSERT IGNORE INTO tags (name) VALUES (?)", [tag]);
        const row = await tx.queryOne<{ id: number }>(
          "SELECT id FROM tags WHERE name = ?",
          [tag],
        );
        if (!row) throw new Error(`tag row missing after insert: ${tag}`);
        await tx.execute(
          "INSERT IGNORE INTO submission_tags (submission_id, tag_id) VALUES (?, ?)",
          [submissionId, row.id],
        );
      }

      return n;
    });
  } catch (err) {
    console.error("submission insert failed", err);
    return showForm(req, ctx, {
      values,
      error: "Something went wrong saving your submission. Please try again.",
      status: 500,
    });
  }

  const eahId = formatEahId(eahNumber);

  // Fire-and-forget email notification. Never throws; failures only log.
  if (hasEmail) {
    void sendSubmissionReceived({
      to: values.submitter_email,
      eahId,
      publicId,
      trackingCode: trackingCodeFull,
      modelLabel: values.ai_model,
      title: values.title,
    });
  }

  const emailLine = hasEmail
    ? h`<p>We've also sent a copy to <code>${values.submitter_email}</code>.
        You'll get more email when reviewers comment, and again when staff
        accept or reject your submission.</p>`
    : h``;

  const body = h`
    <p>Thanks — your submission is in the review queue with the ID
       <code>${eahId}</code>. It won't appear publicly until a staff member
       approves it. If they reject or you withdraw it, that A-number is
       returned to the pool for the next incoming draft.</p>

    <div class="tracking-code-block">
      <p><strong>Your tracking code to chat with reviewers, check status, or withdraw the submission (save this — we won't show it again):</strong></p>
      <pre class="tracking-code">${trackingCodeFull}</pre>
      <p>Use it at <a href="/track">/track</a> any time.</p>
    </div>

    ${emailLine}

    <p>If approved, your entry will live at <code>/e/${eahId}</code>.</p>
    <p><a href="/">Back to home</a> · <a href="/submit">Submit another</a></p>
  `;
  return htmlResponse(layout({
    title: "Submission received · EAH",
    heading: "Submission received",
    body,
    admin: ctx.admin,
  }));
};
