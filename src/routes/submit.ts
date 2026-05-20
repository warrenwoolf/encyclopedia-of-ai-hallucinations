/**
 * GET /submit — show the submission form.
 * POST /submit — validate, rate-limit, insert as `pending`, return a one-time
 * tracking code to the user.
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
import { htmlResponse, parseForm, sanitizeText, type RouteHandler } from "./types.ts";

const LIMITS = {
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

/** Pragmatic email format check. Not RFC-strict; rejects obvious garbage. */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,63}$/;

interface FormValues {
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
}

function emptyForm(): FormValues {
  return {
    prompt: "", output: "", ai_model: "", category: "", tags: "",
    summary: "", notes: "", shared_chat_url: "", author_name: "",
    submitter_email: "",
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
      <p class="field-hint"><small>If you give us an email, we'll notify you when staff
        reviews your submission, and you'll be able to look up all your submissions
        at <a href="/lookup">/lookup</a> without saving a tracking code. See our
        <a href="/privacy">privacy policy</a> for what we do with this.</small></p>

      <button type="submit">Submit</button>
    </form>

    <p><small>Submissions are reviewed by staff before being published. You'll
    receive a tracking code (and an email, if you gave us one) to check status
    or withdraw.</small></p>
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
  };

  // Required + length checks.
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

  // Insert in a single transaction so partial inserts don't leak orphan tag rows.
  try {
    await transaction(async (tx) => {
      const ins = await tx.execute(
        `INSERT INTO submissions
          (public_id, tracking_hash, prompt, output, ai_model, summary, notes, shared_chat_url, category,
           author_name, submitted_at, status, ip_hash, submitter_email, notify_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'pending', ?, ?, ?)`,
        [
          publicId,
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
    });
  } catch (err) {
    console.error("submission insert failed", err);
    return showForm(req, ctx, {
      values,
      error: "Something went wrong saving your submission. Please try again.",
      status: 500,
    });
  }

  // Fire-and-forget email notification. Never throws; failures only log.
  if (hasEmail) {
    void sendSubmissionReceived({
      to: values.submitter_email,
      publicId,
      trackingCode: trackingCodeFull,
      modelLabel: values.ai_model,
    });
  }

  const emailLine = hasEmail
    ? h`<p>We've also sent a copy to <code>${values.submitter_email}</code>.
        You'll get another email when staff review your submission.</p>`
    : h``;

  const body = h`
    <p>Thanks — your submission is in the review queue. It won't appear
       publicly until a staff member approves it.</p>

    <div class="tracking-code-block">
      <p><strong>Your tracking code to track, review, or withdraw your submission (save this — we won't show it again):</strong></p>
      <pre class="tracking-code">${trackingCodeFull}</pre>
      <p>Use it at <a href="/track">/track</a> to check status or withdraw.</p>
    </div>

    ${emailLine}

    <p>Public ID (will be live at <code>/e/${publicId}</code> if approved): <code>${publicId}</code></p>
    <p><a href="/">Back to home</a> · <a href="/submit">Submit another</a></p>
  `;
  return htmlResponse(layout({
    title: "Submission received · EAH",
    heading: "Submission received",
    body,
    admin: ctx.admin,
  }));
};
