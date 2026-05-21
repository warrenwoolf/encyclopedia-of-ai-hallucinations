/**
 * Submitter-facing draft view.
 *
 *   GET  /track                  — show the "enter a tracking code" form.
 *   GET  /track?code=…           — show the draft (status, chat, withdraw button).
 *   GET  /draft/:token           — same as above, with the token in the path.
 *   POST /track/withdraw         — withdraw a pending submission (frees its A-number).
 *   POST /track/message          — submitter posts a chat message into the thread.
 *
 * We never confirm whether a code exists; a wrong code just says "no submission".
 */
import { createHash } from "node:crypto";
import { h, raw, type SafeHtml } from "../html.ts";
import { layout } from "../layout.ts";
import { query, queryOne, transaction } from "../db.ts";
import { tokenForRequest, verifyCsrf } from "../csrf.ts";
import { check as rateCheck } from "../ratelimit.ts";
import { categoryLabel } from "../categories.ts";
import { freeEahNumber, formatEahId } from "../eah-id.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteHandler } from "./types.ts";

const CODE_MAXLEN = 100;
const MESSAGE_MAXLEN = 4000;

interface SubmissionRow {
  id: number;
  public_id: string;
  eah_number: number | null;
  title: string | null;
  ai_model: string;
  category: string;
  entry_status: "active" | "patched";
  submitted_at: Date;
  status: string;
  rejection_reason: string | null;
  staff_review_message: string | null;
}

interface MessageRow {
  id: number;
  sender_type: "staff" | "user" | "system";
  sender_admin_username: string | null;
  body: string;
  created_at: Date;
}

function ymd(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dt(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function trackExplainer(): SafeHtml {
  return h`
    <p>A <strong>tracking code</strong> is a short string you receive after
       submitting a hallucination. Paste it below to:</p>
    <ul>
      <li>check whether your submission has been reviewed,</li>
      <li>see reviewer notes and chat with a staff reviewer,</li>
      <li>or withdraw the submission while it's still pending.</li>
    </ul>
    <p>If you gave us an email address when you submitted, you can instead
       use <a href="/lookup">/lookup</a> to be emailed tracking links for all
       your submissions — no code to save.</p>
    <p>If you didn't save your code and didn't give an email, there's no way
       to recover access — just resubmit the entry.</p>
  `;
}

function lookupForm(opts: { csrf: string; code: string }): SafeHtml {
  return h`
    <form action="/track" method="get" class="track-form">
      <label for="code">Tracking code</label>
      <input id="code" name="code" type="text" maxlength="${CODE_MAXLEN}"
             value="${opts.code}" autocomplete="off" required>
      <button type="submit">Look up</button>
    </form>
  `;
}

/** Renders the chat thread + (if still pending) reply form. */
function chatThread(opts: {
  messages: MessageRow[];
  csrf: string;
  code: string;
  canReply: boolean;
}): SafeHtml {
  const { messages, csrf, code, canReply } = opts;

  const items: SafeHtml = messages.length === 0
    ? h`<p class="muted"><em>No messages yet. If a reviewer leaves a comment,
        you'll see it here (and we'll email you if you gave an address).</em></p>`
    : h`<ol class="chat-thread">
        ${messages.map((m) => {
          const who =
            m.sender_type === "staff"
              ? h`<strong>reviewer${m.sender_admin_username ? h` ${m.sender_admin_username}` : raw("")}</strong>`
              : m.sender_type === "user"
              ? h`<strong>you</strong>`
              : h`<em>system</em>`;
          return h`<li class="chat-message chat-${m.sender_type}">
            <div class="chat-meta">${who} · ${dt(m.created_at)}</div>
            <div class="chat-body">${m.body}</div>
          </li>`;
        })}
      </ol>`;

  const replyForm: SafeHtml = canReply
    ? h`
        <form method="post" action="/track/message" class="chat-reply">
          <input type="hidden" name="_csrf" value="${csrf}">
          <input type="hidden" name="code" value="${code}">
          <label for="message">Reply</label>
          <textarea id="message" name="message" rows="4" maxlength="${MESSAGE_MAXLEN}"
                    required placeholder="Reply to the reviewer…"></textarea>
          <button type="submit">Post reply</button>
        </form>
      `
    : h`<p class="muted"><em>This thread is closed (the submission isn't pending).</em></p>`;

  return h`
    <h2>Conversation with reviewers</h2>
    ${items}
    ${replyForm}
  `;
}

/** Common renderer for "draft view" reachable via either GET /track?code= or /draft/:token. */
async function renderDraftView(req: Request, ctx: { admin: any }, code: string): Promise<Response> {
  const { token: csrf, setCookie } = tokenForRequest(req);

  if (!code || code.length > CODE_MAXLEN) {
    const body = h`
      ${lookupForm({ csrf, code: "" })}
      ${code ? h`<p>No submission with that code.</p>` : trackExplainer()}
    `;
    return htmlResponse(
      layout({ title: "Track · EAH", heading: "Track a submission", body, admin: ctx.admin }),
      { setCookie },
    );
  }

  const hash = createHash("sha256").update(code).digest();
  const row = await queryOne<SubmissionRow>(
    `SELECT id, public_id, eah_number, title, ai_model, category, entry_status, submitted_at,
            status, rejection_reason, staff_review_message
       FROM submissions
       WHERE tracking_hash = ?`,
    [hash],
  );

  if (!row) {
    const body = h`
      ${lookupForm({ csrf, code })}
      <p>No submission with that code.</p>
    `;
    return htmlResponse(
      layout({ title: "Track · EAH", heading: "Track a submission", body, admin: ctx.admin }),
      { setCookie },
    );
  }

  // Fetch the chat thread.
  const messages = await query<MessageRow>(
    `SELECT m.id, m.sender_type, a.username AS sender_admin_username, m.body, m.created_at
       FROM submission_messages m
       LEFT JOIN admins a ON a.id = m.sender_admin_id
       WHERE m.submission_id = ?
       ORDER BY m.created_at ASC, m.id ASC`,
    [row.id],
  );

  // Status-specific section.
  let statusSection: SafeHtml;
  if (row.status === "pending") {
    statusSection = h`
      <p>Your submission is in the review queue.</p>
      <form method="post" action="/track/withdraw" class="withdraw-form">
        <input type="hidden" name="_csrf" value="${csrf}">
        <input type="hidden" name="code" value="${code}">
        <button type="submit">Withdraw this submission</button>
      </form>
      <p class="muted"><small>Withdrawing returns the A-number to the pool for
         the next incoming draft.</small></p>
    `;
  } else if (row.status === "published") {
    const eahId = formatEahId(row.eah_number);
    const url = eahId ? `/e/${eahId}` : `/e/${row.public_id}`;
    statusSection = h`
      <p>Your submission has been published:
        <a href="${url}"><code>${eahId || row.public_id}</code></a>.</p>
      ${row.entry_status === "patched" ? h`<p><em>The entry is marked as <strong>patched</strong> — the
        underlying hallucination no longer reproduces in current models.</em></p>` : raw("")}
    `;
  } else if (row.status === "rejected") {
    statusSection = h`
      <p>Your submission was rejected. The A-number that had been reserved for
         it has been returned to the pool.</p>
      ${row.rejection_reason
        ? h`<p><strong>Reason:</strong> ${row.rejection_reason}</p>`
        : h`<p><em>No reason given.</em></p>`}
    `;
  } else if (row.status === "withdrawn") {
    statusSection = h`<p>This submission has been withdrawn. The A-number has
      been returned to the pool.</p>`;
  } else {
    statusSection = h`<p>Status: ${row.status}</p>`;
  }

  // The staff review message is shown on accept AND reject; it's the
  // reviewer's free-form note to the submitter.
  const staffReviewSection: SafeHtml = row.staff_review_message
    ? h`<p><strong>Note from the reviewer:</strong></p>
        <blockquote class="reviewer-note">${row.staff_review_message}</blockquote>`
    : h``;

  const eahId = formatEahId(row.eah_number);

  const body = h`
    ${lookupForm({ csrf, code })}

    <dl class="entry-meta">
      <dt>EAH ID</dt><dd><code>${eahId || raw("<em>(returned to pool)</em>")}</code></dd>
      ${row.title ? h`<dt>Title</dt><dd>${row.title}</dd>` : raw("")}
      <dt>AI Model</dt><dd>${row.ai_model}</dd>
      <dt>Category</dt><dd>${categoryLabel(row.category)}</dd>
      <dt>Submitted</dt><dd>${ymd(row.submitted_at)}</dd>
      <dt>Status</dt><dd><strong>${row.status}</strong></dd>
    </dl>

    ${statusSection}

    ${staffReviewSection}

    ${chatThread({ messages, csrf, code, canReply: row.status === "pending" })}
  `;

  return htmlResponse(
    layout({ title: "Track · EAH", heading: "Track a submission", body, admin: ctx.admin }),
    { setCookie },
  );
}

export const trackGet: RouteHandler = async (req, ctx) => {
  const code = (ctx.url.searchParams.get("code") ?? "").trim();
  if (!code) {
    const { token, setCookie } = tokenForRequest(req);
    const body = h`
      ${trackExplainer()}
      ${lookupForm({ csrf: token, code: "" })}
    `;
    return htmlResponse(
      layout({ title: "Track · EAH", heading: "Track a submission", body, admin: ctx.admin }),
      { setCookie },
    );
  }
  return renderDraftView(req, ctx, code);
};

/** GET /draft/:token — same content as /track?code=…, with a friendlier URL. */
export const draftGet: RouteHandler = async (req, ctx) => {
  const token = (ctx.params.token ?? "").trim();
  return renderDraftView(req, ctx, token);
};

export const trackWithdrawPost: RouteHandler = async (req, ctx) => {
  const rl = rateCheck("withdraw", ctx.ip);
  if (!rl.allowed) {
    const body = h`<p>Too many withdrawal requests. Please retry in ${rl.retryAfterSec ?? 60} seconds.</p>`;
    return htmlResponse(
      layout({ title: "Rate limited · EAH", heading: "Slow down", body, admin: ctx.admin }),
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } },
    );
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 8 * 1024);
  } catch {
    const body = h`<p>Request too large.</p>`;
    return htmlResponse(
      layout({ title: "Error · EAH", heading: "Error", body, admin: ctx.admin }),
      { status: 413 },
    );
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    const body = h`<p>Invalid CSRF token. Reload the form and try again.</p>`;
    return htmlResponse(
      layout({ title: "Forbidden · EAH", heading: "Forbidden", body, admin: ctx.admin }),
      { status: 403 },
    );
  }

  const code = (form.get("code") ?? "").trim();
  if (!code || code.length > CODE_MAXLEN) {
    // Treat as a no-op redirect so we don't leak anything.
    return new Response(null, { status: 303, headers: { Location: "/track" } });
  }

  const hash = createHash("sha256").update(code).digest();
  const row = await queryOne<{ id: number; status: string }>(
    "SELECT id, status FROM submissions WHERE tracking_hash = ?",
    [hash],
  );

  if (row && row.status === "pending") {
    // Withdraw + free the A-number atomically. Same reasoning as in
    // admin/review.ts: the status flip and the number-free MUST be a single
    // transaction so no reader ever sees "withdrawn but still numbered".
    try {
      await transaction(async (tx) => {
        await tx.execute(
          "UPDATE submissions SET status = 'withdrawn' WHERE id = ? AND status = 'pending'",
          [row.id],
        );
        await freeEahNumber(tx, row.id);
        await tx.execute(
          `INSERT INTO submission_messages (submission_id, sender_type, body)
           VALUES (?, 'system', ?)`,
          [row.id, "Submission withdrawn by the submitter. A-number returned to the pool."],
        );
      });
    } catch (err) {
      console.error("withdraw failed", err);
      // Fall through; the user will see no change and can retry.
    }
  }

  // Redirect back regardless — view will show the new status (or "no submission").
  const target = `/track?code=${encodeURIComponent(code)}`;
  return new Response(null, { status: 303, headers: { Location: target } });
};

/** POST /track/message — submitter posts a chat message into the thread. */
export const trackMessagePost: RouteHandler = async (req, ctx) => {
  // Share the withdraw bucket — we don't want this to be an unbounded write
  // channel. Reasonable cap of 20/hour for chat per IP.
  const rl = rateCheck("withdraw", ctx.ip);
  if (!rl.allowed) {
    const body = h`<p>Too many messages from this IP. Please retry in ${rl.retryAfterSec ?? 60} seconds.</p>`;
    return htmlResponse(
      layout({ title: "Rate limited · EAH", heading: "Slow down", body, admin: ctx.admin }),
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } },
    );
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 16 * 1024);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    const body = h`<p>Invalid CSRF token. Reload the form and try again.</p>`;
    return htmlResponse(
      layout({ title: "Forbidden · EAH", heading: "Forbidden", body, admin: ctx.admin }),
      { status: 403 },
    );
  }

  const code = (form.get("code") ?? "").trim();
  const message = sanitizeText(form.get("message") ?? "").trim();

  if (!code || code.length > CODE_MAXLEN || message.length === 0 || message.length > MESSAGE_MAXLEN) {
    return new Response(null, { status: 303, headers: { Location: "/track" } });
  }

  const hash = createHash("sha256").update(code).digest();
  const row = await queryOne<{ id: number; status: string }>(
    "SELECT id, status FROM submissions WHERE tracking_hash = ?",
    [hash],
  );

  // Only allow posting while the submission is pending — once it's decided,
  // the thread is read-only for the submitter.
  if (row && row.status === "pending") {
    try {
      const { execute } = await import("../db.ts");
      await execute(
        `INSERT INTO submission_messages (submission_id, sender_type, body)
         VALUES (?, 'user', ?)`,
        [row.id, message],
      );
    } catch (err) {
      console.error("submitter message insert failed", err);
    }
  }

  return new Response(null, {
    status: 303,
    headers: { Location: `/track?code=${encodeURIComponent(code)}` },
  });
};
