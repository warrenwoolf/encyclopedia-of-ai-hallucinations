/**
 * GET /submit — show the submission form.
 * POST /submit — validate, rate-limit, and insert as `draft` (private) or
 * `unreviewed` (public immediately, hidden from default lists). No A-number is
 * allocated here — that happens only when a reviewed entry is reproduced.
 * Returns the dashboard redirect (proposed) or the draft edit page (draft).
 */
import { randomBytes, createHash } from "node:crypto";
import { h, raw, type SafeHtml } from "../html.ts";
import { layout, pageResponse } from "../layout.ts";
import { execute, transaction, queryOne } from "../db.ts";
import { tokenForRequest, verifyCsrf } from "../csrf.ts";
import { check as rateCheck } from "../ratelimit.ts";
import { CATEGORIES, isValidCategory } from "../categories.ts";
import { config } from "../config.ts";
import { isSuspended } from "../auth.ts";
import { notifyNewSubmission } from "../discord.ts";
import { formatEahId } from "../eah-id.ts";
import {
  type TranscriptMode, type Turn,
  renderTranscriptFields, readTranscriptForm, applyTurnAction,
  deriveLegacyPair,
} from "../turns.ts";
import { replaceTurns } from "../turns-db.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteHandler } from "./types.ts";

const LIMITS = {
  title: 200,
  prompt: 8000,
  output: 32000,
  ai_model: 120,
  summary: 2000,
  notes: 4000,
  shared_chat_url: 2048,
  source_url: 2048,
  tags: 600, // bounding the raw tags input
};

/** Submission shape: a pasted transcript, or a link to a third-party post. */
type SubmissionKind = "transcript" | "link";

/**
 * Drafts are unlimited. The cap is on submissions *awaiting review* (status
 * 'unreviewed') per account, so a user can't flood the staff queue. Enforced both
 * here (the "Submit for review" button) and in my.ts (the "propose" action).
 */
export const MAX_PENDING_PER_USER = 5;

/** Pragmatic ISO-8601 date check, in the past or today. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface FormValues {
  title: string;
  // 'transcript' = pasted conversation (the mode/turns/block fields below).
  // 'link' = a link to a third-party social-media post; the transcript fields
  // are ignored and `source_url` + `summary` carry the entry.
  kind: SubmissionKind;
  // Transcript: `mode` chooses single/turns/block; `turns` seeds the structured
  // boxes; `block` seeds the pasted textarea. Legacy single prompt/output is
  // represented as a one- or two-turn list in `turns` with mode 'turns'.
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
  source_url: string;
  hallucination_date: string;
  allow_author_edits: boolean;
  anon_public: boolean;
}

function emptyForm(): FormValues {
  return {
    title: "",
    kind: "transcript",
    mode: "turns",
    turns: [
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ],
    block: "",
    userDelim: "", assistantDelim: "",
    ai_model: "", category: "", tags: "",
    summary: "", notes: "", shared_chat_url: "", source_url: "",
    hallucination_date: "", allow_author_edits: false, anon_public: false,
  };
}

function renderForm(opts: {
  values: FormValues;
  csrf: string;
  error: string | null;
  username: string;
}): SafeHtml {
  const { values, csrf, error, username } = opts;
  const errBlock = error
    ? h`<div class="form-error" role="alert"><strong>Error:</strong> ${error}</div>`
    : h``;

  const categoryOptions = h`${CATEGORIES.map(
    (c) => h`<option value="${c.key}" ${values.category === c.key ? raw('selected') : raw('')}>${c.label}</option>`,
  )}`;

  // Submission is account-only, so a session always exists to restore the
  // autosaved draft from.
  const autosaveAttr = raw('data-autosave="eah-submit-draft"');

  return h`
    ${errBlock}
    <form method="post" action="/submit" class="submit-form" ${autosaveAttr}>
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

      <label for="category">Category <small>(optional — leave blank and our reviewers will categorize it)</small></label>
      <select id="category" name="category">
        <option value="">-- let staff choose --</option>
        ${categoryOptions}
      </select>

      <fieldset class="submission-kind">
        <legend>What are you submitting?</legend>
        <label class="checkbox-label">
          <input type="radio" name="submission_kind" value="transcript"
                 ${values.kind !== "link" ? raw("checked") : raw("")}>
          A transcript I'm pasting (a prompt + response, or a whole conversation)
        </label>
        <label class="checkbox-label">
          <input type="radio" name="submission_kind" value="link"
                 ${values.kind === "link" ? raw("checked") : raw("")}>
          A link to a social-media post (Reddit, X, etc.) showing the failure
        </label>
        <p class="field-hint"><small>For a <strong>link</strong> submission, fill in
          <em>Source URL</em> and <em>Summary</em> below and leave the conversation
          boxes blank. Because links rot, the Summary must quote or describe the
          failure so the entry stands on its own. Link submissions can be reviewed
          but are <strong>not eligible for staff reproduction</strong>.</small></p>
      </fieldset>

      <label for="source_url">Source URL <small>(required for a link submission)</small></label>
      <input id="source_url" name="source_url" type="url" maxlength="${LIMITS.source_url}"
             value="${values.source_url}" placeholder="https://www.reddit.com/r/...">

      ${renderTranscriptFields({ mode: values.mode, turns: values.turns, block: values.block, userDelim: values.userDelim, assistantDelim: values.assistantDelim })}

      <label for="summary">Summary <small>(optional, what's wrong about it)</small></label>
      <textarea id="summary" name="summary" rows="3" maxlength="${LIMITS.summary}"
                data-char-count="summary-count"
                placeholder="optional: 1-2 sentences explaining what's hallucinated">${values.summary}</textarea>
      <small id="summary-count" class="char-count">0 / ${LIMITS.summary} chars</small>

      <label for="notes">Notes <small>(optional, anything else that doesn't fit elsewhere)</small></label>
      <textarea id="notes" name="notes" rows="4" maxlength="${LIMITS.notes}"
                data-char-count="notes-count"
                placeholder="optional: reproduction steps, context about the conversation, related links, etc.">${values.notes}</textarea>
      <small id="notes-count" class="char-count">0 / ${LIMITS.notes} chars</small>

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

      <p class="field-checkbox">
        <label class="checkbox-label">
          <input type="checkbox" name="anon_public" value="1"
                 ${values.anon_public ? raw('checked') : raw('')}>
          Make this submission anonymous to the public.
        </label>
        <span class="field-hint"><small>By default your username
          (<strong>${username}</strong>) is shown publicly as the author of this
          entry. Check this box to stay anonymous — the public entry will say
          "anonymous" and only staff will be able to see that you submitted it.</small></span>
      </p>

      <p class="field-checkbox">
        <label class="checkbox-label">
          <input type="checkbox" name="allow_author_edits" value="1"
                 ${values.allow_author_edits ? raw('checked') : raw('')}>
          Allow ENAIH staff to edit this submission (e.g. to add reproduction
          notes, fix typos, or update the patched status). You can always edit
          your own submission regardless.
        </label>
      </p>

      <p class="field-hint"><small><strong>Submit for review</strong> publishes
        this entry right away: it goes live as <em>unreviewed</em> (reachable by
        link, hidden from the default listings) and enters the staff review queue,
        where it can climb the trust ladder toward a permanent A-number.
        <strong>Save as draft</strong> just stores it privately — nothing is
        published or sent to staff until you propose it later from
        <a href="/my/submissions">/my/submissions</a>.</small></p>

      <div class="form-actions">
        <button type="submit" name="action" value="propose">Submit for review</button>
        <button type="submit" name="action" value="draft" class="btn-secondary">Save as draft</button>
      </div>
    </form>

    <p><small>Submitting for review publishes your entry immediately as
    <em>unreviewed</em>; staff vet it afterward and it climbs the trust ladder.
    Manage your drafts and chat with reviewers from
    <a href="/my/submissions">/my/submissions</a>. You can keep as many drafts
    as you like; you may have at most ${MAX_PENDING_PER_USER} submissions
    in the review queue at once.</small></p>
  `;
}

async function showForm(req: Request, ctx: { user: any }, opts: { values?: FormValues; error?: string | null; status?: number } = {}): Promise<Response> {
  const { token, setCookie } = tokenForRequest(req);
  const body = renderForm({
    values: opts.values ?? emptyForm(),
    csrf: token,
    error: opts.error ?? null,
    username: ctx.user?.username ?? "",
  });
  return pageResponse(req,
      { title: "Submit · ENAIH", heading: "Submit a hallucination", body, user: ctx.user, bodyClass: "text-page" },
      { status: opts.status ?? 200, setCookie },
    );
}

/**
 * Page shown to a timed-out user in place of the submit form. They keep their
 * session and can browse; they just can't submit until the window passes.
 */
function showSuspendedNotice(req: Request, ctx: { user: any }, status = 403): Response {
  const until = ctx.user?.suspendedUntil ? new Date(ctx.user.suspendedUntil) : null;
  const untilStr = until ? until.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
  const reason = ctx.user?.suspendedReason as string | null;
  const body = h`
    <p>Your account is currently <strong>timed out</strong>, so you can't submit
       or propose submissions right now. You can still browse and manage your
       existing drafts.</p>
    ${untilStr ? h`<p>The timeout lifts at <strong>${untilStr}</strong>.</p>` : raw("")}
    ${reason ? h`<p>Reason given by staff: <em>${reason}</em></p>` : raw("")}
    <p><a href="/my/submissions">My submissions</a> · <a href="/browse">Browse</a></p>
  `;
  return pageResponse(req,
    { title: "Timed out · ENAIH", heading: "You're timed out", body, user: ctx.user },
    { status },
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
  // Submission requires an account. Anonymous visitors are sent to log in.
  if (!ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }
  if (isSuspended(ctx.user)) return showSuspendedNotice(req, ctx, 200);
  return showForm(req, ctx);
};

export const submitPost: RouteHandler = async (req, ctx) => {
  // Hard gate: no session, no submission. This is enforced on POST as well as
  // GET so the endpoint can't be hit directly with a crafted request.
  if (!ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  // Timed-out users can't submit. Enforced on POST too so a crafted request
  // can't slip past the GET notice.
  if (isSuspended(ctx.user)) return showSuspendedNotice(req, ctx, 403);

  // Rate-limit first; cheap and avoids parsing huge bodies under attack.
  const rl = rateCheck("submit", ctx.ip);
  if (!rl.allowed) {
    const body = h`<p>Too many submissions. Please retry in ${rl.retryAfterSec ?? 60} seconds.</p>`;
    return pageResponse(req,
      { title: "Rate limited · ENAIH", heading: "Slow down", body, user: ctx.user },
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
    return pageResponse(req,
      { title: "Forbidden · ENAIH", heading: "Forbidden", body, user: ctx.user },
      { status: 403 },
    );
  }

  const scrub = (k: string) => sanitizeText(form.get(k) ?? "").trim();
  const scrubText = (s: string) => sanitizeText(s);
  // Raw turn fields, so we can re-render the form on a no-JS add/remove action
  // without losing what the user typed. parseForm runs the body through
  // URLSearchParams, so repeated turn_role/turn_content come back via getAll().
  const rawMode: TranscriptMode =
    form.get("transcript_mode") === "block" ? "block" : "turns";
  const rawTurns: Turn[] = (() => {
    const roles = form.getAll("turn_role");
    const contents = form.getAll("turn_content");
    const out: Turn[] = [];
    const n = Math.max(roles.length, contents.length);
    for (let i = 0; i < n; i++) {
      out.push({
        role: (roles[i] ?? "user").toLowerCase() === "assistant" ? "assistant" : "user",
        content: scrubText(contents[i] ?? ""),
      });
    }
    return out;
  })();
  const rawBlock = scrubText(form.get("transcript_block") ?? "");

  const values: FormValues = {
    title: scrub("title"),
    kind: form.get("submission_kind") === "link" ? "link" : "transcript",
    mode: rawMode,
    turns: rawTurns.length > 0 ? rawTurns : emptyForm().turns,
    block: rawBlock,
    userDelim: scrub("block_user_delim").slice(0, 80),
    assistantDelim: scrub("block_assistant_delim").slice(0, 80),
    ai_model: scrub("ai_model"),
    category: scrub("category"),
    tags: scrub("tags"),
    summary: scrub("summary"),
    notes: scrub("notes"),
    shared_chat_url: scrub("shared_chat_url"),
    source_url: scrub("source_url"),
    hallucination_date: scrub("hallucination_date"),
    allow_author_edits: form.get("allow_author_edits") === "1",
    anon_public: form.get("anon_public") === "1",
  };

  // No-JS fallback: the "Add turn" / "Remove turn" buttons post action=add_turn
  // / remove_turn:N. Re-render the form with the adjusted turn list (no save).
  const action = form.get("action") ?? "";
  const turnAction = applyTurnAction(action, values.turns);
  if (turnAction) {
    return showForm(req, ctx, { values: { ...values, turns: turnAction }, status: 200 });
  }

  // Required + length checks.
  if (!values.title) return showForm(req, ctx, { values, error: "Title is required.", status: 400 });
  if (values.title.length > LIMITS.title)
    return showForm(req, ctx, { values, error: `Title is too long (max ${LIMITS.title} chars).`, status: 400 });

  // Branch on submission kind. A 'link' submission has no transcript: it carries
  // a source URL plus a self-contained Summary (link-rot insurance) and stores
  // empty prompt/output. A 'transcript' submission parses the conversation and
  // mirrors a legacy prompt/output pair for the browse `q` LIKE search.
  let legacyPrompt = "";
  let legacyOutput = "";
  let storedMode: TranscriptMode;
  let storedTurns: Turn[] = [];
  let sourceUrlValue: string | null = null;

  if (values.kind === "link") {
    if (!values.source_url)
      return showForm(req, ctx, { values, error: "A link submission needs a Source URL.", status: 400 });
    let parsed: URL | null = null;
    try { parsed = new URL(values.source_url); } catch { /* invalid */ }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || values.source_url.length > LIMITS.source_url)
      return showForm(req, ctx, { values, error: "Source URL must be a valid http(s) URL.", status: 400 });
    if (!values.summary)
      return showForm(req, ctx, {
        values,
        error: "For a link submission, paste the quoted text or a description into Summary so the entry survives link rot.",
        status: 400,
      });
    storedMode = "link";
    sourceUrlValue = values.source_url;
  } else {
    const transcript = readTranscriptForm(form, scrubText);
    if (!transcript.ok) return showForm(req, ctx, { values, error: transcript.error, status: 400 });
    const pair = deriveLegacyPair(transcript.turns);
    legacyPrompt = pair.prompt;
    legacyOutput = pair.output;
    // Collapse the trivial case to 'single' (a lone turn, or one user + one
    // assistant turn): no submission_turns rows needed, prompt/output suffice.
    const isTrivial =
      transcript.turns.length <= 1 ||
      (transcript.turns.length === 2 &&
        transcript.turns[0]!.role === "user" &&
        transcript.turns[1]!.role === "assistant");
    storedMode = isTrivial ? "single" : transcript.mode;
    storedTurns = storedMode === "single" ? [] : transcript.turns;
  }

  if (!values.ai_model) return showForm(req, ctx, { values, error: "AI model is required.", status: 400 });
  if (values.ai_model.length > LIMITS.ai_model)
    return showForm(req, ctx, { values, error: `AI model name is too long (max ${LIMITS.ai_model} chars).`, status: 400 });

  // Category is optional; staff assign one before publishing. But if the
  // submitter did pick something, it must be a real category.
  if (values.category && !isValidCategory(values.category))
    return showForm(req, ctx, { values, error: "Please choose a valid category, or leave it blank.", status: 400 });

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

  if (values.tags.length > LIMITS.tags)
    return showForm(req, ctx, { values, error: "Tags input is too long.", status: 400 });

  const tagResult = parseTags(values.tags);
  if (!tagResult.ok) return showForm(req, ctx, { values, error: tagResult.error, status: 400 });
  const tags = tagResult.tags;

  // Two submit buttons: "Submit for review" publishes immediately as
  // 'unreviewed' (public, hidden from default lists); "Save as draft" keeps it
  // private ('draft'). Anything else defaults to draft.
  const wantPropose = form.get("action") === "propose";

  // Drafts are unlimited. Only the "Submit for review" path is capped, on the
  // number of submissions already awaiting review. We let them save as a draft
  // regardless, so nothing they typed is lost.
  if (wantPropose) {
    const pendingRow = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM submissions
        WHERE owner_user_id = ? AND status = 'unreviewed'`,
      [ctx.user.userId],
    );
    const pending = Number(pendingRow?.n ?? 0);
    if (pending >= MAX_PENDING_PER_USER) {
      return showForm(req, ctx, {
        values,
        error: `You already have ${pending} submissions awaiting review, which is ` +
          `the maximum (${MAX_PENDING_PER_USER}). You can still save this as a draft — ` +
          `use the “Save as draft” button below. To submit it for review later, first ` +
          `wait for a decision on one of your pending submissions, or withdraw one back ` +
          `to a draft from your submissions page.`,
        status: 429,
      });
    }
  }

  // Generate IDs and hashes.
  const publicId = await generateUniquePublicId();
  // Legacy NOT NULL column; no one reads it anymore. Random bytes satisfy the constraint.
  const dummyTrackingHash = createHash("sha256").update(randomBytes(32)).digest();
  const ipHash = createHash("sha256")
    .update(`${config.sessionSecret}:${ctx.ip}`)
    .digest();

  // Submission is account-only now: every row is owned by the submitter, with
  // no submitter_email (notifications go through the account).
  const submitterEmail = null;
  // Non-draft submissions go public immediately as 'unreviewed' (hidden from
  // default listings, viewable by link). A-numbers are NOT allocated here — they
  // come only when a reviewed entry is marked 'reproduced' (see admin/review.ts).
  const submissionStatus = wantPropose ? "unreviewed" : "draft";
  const ownerUserId = ctx.user.userId;

  let newSubmissionId: number;
  // Insert in a single transaction so partial inserts don't leak orphan tag rows.
  try {
    const result = await transaction(async (tx) => {
      // REVIEWER NOTE: Verify all mathematical claims, code, and factual content
      // before approving. AI-assisted submissions have historically included wrong
      // factorizations, hallucinated citations, and incorrect proofs.
      const ins = await tx.execute(
        `INSERT INTO submissions
          (public_id, title, tracking_hash, prompt, output, ai_model, summary, notes,
           shared_chat_url, source_url, category, author_name, submitted_at, status, ip_hash,
           submitter_email, hallucination_date, allow_author_edits, owner_user_id, anon_public,
           transcript_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          publicId,
          values.title,
          dummyTrackingHash,
          // Mirror the first user/assistant turn into the legacy columns so the
          // NOT NULL constraint holds and the browse `q` LIKE search still works.
          // (Link submissions store empty strings here.)
          legacyPrompt,
          legacyOutput,
          values.ai_model,
          values.summary.length > 0 ? values.summary : null,
          values.notes.length > 0 ? values.notes : null,
          values.shared_chat_url.length > 0 ? values.shared_chat_url : null,
          sourceUrlValue,
          values.category,
          // No free-text display name anymore: public attribution is the
          // account username (or "anonymous" if anon_public is set).
          null,
          submissionStatus,
          ipHash,
          submitterEmail,
          hallucinationDate,
          values.allow_author_edits ? 1 : 0,
          ownerUserId,
          values.anon_public ? 1 : 0,
          storedMode,
        ],
      );
      const submissionId = ins.insertId;
      if (!submissionId) throw new Error("insert returned no id");

      // Multi-turn rows (none for 'single' or 'link').
      await replaceTurns(tx, submissionId, storedTurns);

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

      // If the submitter chose "Submit for review", record the proposal in the
      // discussion thread inside the same transaction so the queue + chat are
      // consistent the moment the row becomes visible to staff.
      if (wantPropose) {
        await tx.execute(
          `INSERT INTO submission_messages (submission_id, sender_type, body) VALUES (?, 'system', ?)`,
          [submissionId, `Submission proposed for review by ${ctx.user!.username}.`],
        );
      }

      return { submissionId };
    });
    newSubmissionId = Number(result.submissionId);
  } catch (err) {
    console.error("submission insert failed", err);
    return showForm(req, ctx, {
      values,
      error: "Something went wrong saving your submission. Please try again.",
      status: 500,
    });
  }

  // If it went straight into the review queue, ping the staff Discord channel.
  // No A-number yet (allocated only at reproduction), so we link by public_id.
  if (wantPropose) {
    void notifyNewSubmission({
      submissionId: newSubmissionId,
      eahId: "",
      publicId,
      title: values.title,
      modelLabel: values.ai_model,
      username: ctx.user.username,
      anon: values.anon_public,
    });
  }

  // Proposed → straight to the dashboard (it's now public + in the review queue).
  // Draft → the edit page (addressed by slug) so the submitter can keep refining.
  return new Response(null, {
    status: 303,
    headers: {
      Location: wantPropose ? "/my/submissions" : `/my/submissions/${publicId}/edit`,
    },
  });
};
