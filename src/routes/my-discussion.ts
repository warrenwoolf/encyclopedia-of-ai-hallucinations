/**
 * Discussion thread for user-owned submissions.
 *
 *   GET  /my/submissions/:eahId/discussion  — view message thread
 *   POST /my/submissions/:eahId/message     — post a new message
 *
 * Ownership is verified via eah_number + owner_user_id, same as my.ts.
 * The discussion is visible for any status, but replies are only allowed
 * when status is 'draft' or 'pending'.
 *
 * Rate limiting: we reuse the 'withdraw' bucket (20/hour per IP) — low-volume
 * per-IP cap that's already defined and appropriate for this action.
 */

import { h, raw, type SafeHtml } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { query, queryOne, execute } from "../db.ts";
import { verifyCsrf } from "../csrf.ts";
import { check as rateCheck } from "../ratelimit.ts";
import { formatEahId } from "../eah-id.ts";
import { actionBar } from "./my-shared.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteHandler } from "./types.ts";

const MAX_MESSAGE_CHARS = 4000;

// ─── shared ownership helper ─────────────────────────────────────────────────

interface OwnedRow {
  id: number;
  eah_number: number | null;
  public_id: string;
  owner_user_id: number;
  status: string;
  title: string | null;
}

/** Resolve an owned submission by its public_id slug (owner routes address by
 *  slug — A-numbers only exist once an entry is reproduced). */
async function fetchOwned(slug: string, userId: number): Promise<OwnedRow | null> {
  if (!slug) return null;
  const row = await queryOne<OwnedRow>(
    `SELECT id, eah_number, public_id, owner_user_id, status, title
       FROM submissions
      WHERE public_id = ? AND owner_user_id = ?`,
    [slug, userId],
  );
  return row ?? null;
}

// ─── rendering helpers ────────────────────────────────────────────────────────

export interface MessageRow {
  id: number;
  submission_id: number;
  sender_type: string;
  sender_user_id: number | null;
  body: string;
  created_at: Date;
  sender_username: string | null;
}

export function renderNote(msg: MessageRow): SafeHtml {
  const ts = new Date(msg.created_at);
  // Display as YYYY-MM-DD HH:MM UTC (minute granularity is fine here)
  const dateStr = ts.toISOString().slice(0, 16).replace("T", " ");

  if (msg.sender_type === "system") {
    return h`
      <div class="discuss-note discuss-note-system">
        <div class="discuss-meta">
          <span class="discuss-date">${dateStr}</span>
        </div>
        <div>
          <span class="system-message">${msg.body}</span>
        </div>
      </div>
    `;
  }

  let senderLabel: SafeHtml;
  if (msg.sender_type === "staff") {
    const name = msg.sender_username ?? "staff";
    senderLabel = h`<span class="discuss-user discuss-user-staff">Reviewer (${name})</span>`;
  } else {
    const name = msg.sender_username ?? "user";
    senderLabel = h`<span class="discuss-user discuss-user-submitter">${name}</span>`;
  }

  return h`
    <div class="discuss-note">
      <div class="discuss-meta">
        <span class="discuss-date">${dateStr}</span>
      </div>
      <div>
        ${senderLabel}:
        <pre class="note">${msg.body}</pre>
      </div>
    </div>
  `;
}

// ─── myDiscussionGet ──────────────────────────────────────────────────────────

export const myDiscussionGet: RouteHandler = async (req, ctx) => {
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

  const messages = await query<MessageRow>(
    `SELECT m.id, m.submission_id, m.sender_type, m.sender_user_id,
            m.body, m.created_at, u.username AS sender_username
       FROM submission_messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
      WHERE m.submission_id = ?
      ORDER BY m.created_at ASC`,
    [row.id],
  );

  const { token, setCookie } = (await import("../csrf.ts")).tokenForRequest(req);

  const threadHtml: SafeHtml = messages.length > 0
    ? h`<div class="discuss-thread">${messages.map(renderNote)}</div>`
    : h`<p class="muted">No messages yet.</p>`;

  const canReply = row.status === "draft" || row.status === "unreviewed";
  const replyForm: SafeHtml = canReply
    ? h`
      <div class="discuss-reply">
        <form method="post" action="/my/submissions/${slug}/message">
          <input type="hidden" name="_csrf" value="${token}">
          <label for="message">Reply</label>
          <textarea id="message" name="message" rows="5"
                    maxlength="${MAX_MESSAGE_CHARS}"
                    placeholder="Write a message to the reviewer…"></textarea>
          <div class="form-actions">
            <button type="submit">Send</button>
          </div>
        </form>
      </div>
    `
    : h`<p class="muted">Discussion is closed (status: ${row.status}).</p>`;

  const subnav = actionBar(slug, row.status, token, eahId);

  const body = h`
    <p><strong>${dispId}</strong> — ${row.title ?? "(untitled)"}</p>
    ${threadHtml}
    ${replyForm}
  `;

  return pageResponse(req, {
    title: `Discussion ${dispId} · ENAIH`,
    heading: `Discussion — ${dispId}`,
    body,
    user: ctx.user,
    subnav,
  }, { setCookie });
};

// ─── myDiscussionPost ─────────────────────────────────────────────────────────

export const myDiscussionPost: RouteHandler = async (req, ctx) => {
  if (!ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  // Rate limit before parsing body.
  const rl = rateCheck("withdraw", ctx.ip);
  if (!rl.allowed) {
    return pageResponse(req, {
      title: "Rate limited · ENAIH",
      heading: "Slow down",
      body: h`<p>Too many messages. Please retry in ${String(rl.retryAfterSec ?? 60)} seconds.</p>`,
      user: ctx.user,
    }, { status: 429 });
  }

  const eahIdStr = ctx.params.eahId ?? "";

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 32 * 1024);
  } catch {
    return new Response(null, { status: 413 });
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

  if (!row || (row.status !== "draft" && row.status !== "unreviewed")) {
    return new Response(null, { status: 404 });
  }
  const slug = row.public_id;

  const rawBody = sanitizeText(form.get("message") ?? "").trim();

  // Empty message: redirect silently without inserting.
  if (rawBody.length === 0) {
    return new Response(null, {
      status: 303,
      headers: { Location: `/my/submissions/${slug}/discussion` },
    });
  }

  if (rawBody.length > MAX_MESSAGE_CHARS) {
    return pageResponse(req, {
      title: "Error · ENAIH",
      heading: "Error",
      body: h`<p>Message too long (max ${String(MAX_MESSAGE_CHARS)} characters).</p>`,
      user: ctx.user,
    }, { status: 400 });
  }

  await execute(
    `INSERT INTO submission_messages (submission_id, sender_type, sender_user_id, body)
     VALUES (?, 'user', ?, ?)`,
    [row.id, ctx.user.userId, rawBody],
  );

  return new Response(null, {
    status: 303,
    headers: { Location: `/my/submissions/${slug}/discussion` },
  });
};
