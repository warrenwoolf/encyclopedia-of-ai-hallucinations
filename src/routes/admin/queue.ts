/**
 * Admin queue (pending submissions list + single-submission detail/review).
 *
 *   GET /admin/queue       — list pending submissions
 *   GET /admin/queue/:id   — full submission view with review form
 */
import { h, raw, type SafeHtml } from "../../html.ts";
import { layout } from "../../layout.ts";
import { query, queryOne } from "../../db.ts";
import { categoryLabel } from "../../categories.ts";
import { tokenForRequest } from "../../csrf.ts";
import { formatEahId } from "../../eah-id.ts";
import { htmlResponse, type RouteContext } from "../types.ts";

interface PendingRow {
  id: number;
  public_id: string;
  eah_number: number | null;
  title: string | null;
  ai_model: string | null;
  category: string;
  submitted_at: Date;
}

interface SubmissionFull {
  id: number;
  public_id: string;
  eah_number: number | null;
  title: string | null;
  prompt: string;
  output: string;
  ai_model: string | null;
  summary: string | null;
  notes: string | null;
  shared_chat_url: string | null;
  category: string;
  entry_status: "active" | "patched";
  hallucination_date: string | null;
  allow_author_edits: number;
  author_name: string | null;
  submitter_email: string | null;
  submitted_at: Date;
  status: "pending" | "published" | "rejected" | "withdrawn";
  reviewed_by: number | null;
  reviewed_at: Date | null;
  reviewer_notes: string | null;
  staff_review_message: string | null;
  verified_hits: number | null;
  verified_total: number | null;
  rejection_reason: string | null;
  ip_hash: Buffer | null;
}

interface MessageRow {
  id: number;
  sender_type: "staff" | "user" | "system";
  sender_admin_username: string | null;
  body: string;
  created_at: Date;
}

function dt(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function statusBadge(status: string): string {
  return `[${status}]`;
}

function authRedirect(): Response {
  return new Response(null, { status: 303, headers: { Location: "/admin/login" } });
}

export async function getQueue(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();

  const { token: csrfToken, setCookie } = tokenForRequest(req);

  const rows = await query<PendingRow>(
    `SELECT id, public_id, eah_number, title, ai_model, category, submitted_at
       FROM submissions
       WHERE status = 'pending'
       ORDER BY submitted_at ASC
       LIMIT 1000`,
  );

  const tableBody: SafeHtml = rows.length === 0
    ? h`<p><em>The queue is empty.</em></p>`
    : h`
        <table class="queue">
          <thead>
            <tr>
              <th>EAH ID</th>
              <th>title</th>
              <th>model</th>
              <th>category</th>
              <th>submitted</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => h`
              <tr>
                <td><code>${formatEahId(r.eah_number)}</code></td>
                <td>${r.title ?? h`<em>(no title)</em>`}</td>
                <td>${r.ai_model ?? ""}</td>
                <td>${categoryLabel(r.category)}</td>
                <td>${fmtDate(r.submitted_at)}</td>
                <td><a href="/admin/queue/${r.id}">review →</a></td>
              </tr>
            `)}
          </tbody>
        </table>
      `;

  const body = h`
    <p>${rows.length} pending submission${rows.length === 1 ? "" : "s"}.
       <a href="/admin/entries/new">+ add a new entry directly</a>
       (bypasses the draft queue).</p>
    ${tableBody}
  `;

  const html = layout({
    title: "Admin queue",
    heading: "Pending submissions",
    body,
    admin: { username: ctx.admin.username, csrfToken },
  });
  return htmlResponse(html, { setCookie });
}

export async function getQueueDetail(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();

  const idStr = ctx.params.id;
  const id = idStr && /^\d+$/.test(idStr) ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id) || id <= 0) {
    return notFound(ctx);
  }

  const row = await queryOne<SubmissionFull>(
    `SELECT id, public_id, eah_number, title, prompt, output, ai_model, summary, notes,
            shared_chat_url, category, entry_status, hallucination_date, allow_author_edits,
            author_name, submitter_email, submitted_at, status, reviewed_by, reviewed_at,
            reviewer_notes, staff_review_message, verified_hits, verified_total,
            rejection_reason, ip_hash
       FROM submissions
       WHERE id = ?`,
    [id],
  );
  if (!row) return notFound(ctx);

  const tags = await query<{ name: string }>(
    `SELECT t.name FROM submission_tags st
       JOIN tags t ON t.id = st.tag_id
       WHERE st.submission_id = ?
       ORDER BY t.name ASC`,
    [id],
  );

  const messages = await query<MessageRow>(
    `SELECT m.id, m.sender_type, a.username AS sender_admin_username, m.body, m.created_at
       FROM submission_messages m
       LEFT JOIN admins a ON a.id = m.sender_admin_id
       WHERE m.submission_id = ?
       ORDER BY m.created_at ASC, m.id ASC`,
    [id],
  );

  const ipPrefix = row.ip_hash
    ? Buffer.from(row.ip_hash).toString("hex").slice(0, 12)
    : "";

  const { token: csrfToken, setCookie: csrfSetCookie } = tokenForRequest(req);

  const alreadyReviewed: SafeHtml = row.status !== "pending"
    ? h`<p class="notice">
        This submission has already been reviewed (status <strong>${row.status}</strong>${
          row.reviewed_at ? h` at ${fmtDate(row.reviewed_at)}` : raw("")
        }). You may still re-review it below.
      </p>`
    : raw("");

  const tagsHtml: SafeHtml = tags.length === 0
    ? h`<em>none</em>`
    : h`${tags.map((t, i) => h`${i > 0 ? ", " : ""}<code>${t.name}</code>`)}`;

  const summaryHtml: SafeHtml = row.summary
    ? h`<h3>Summary</h3><p>${row.summary}</p>`
    : raw("");

  const notesHtml: SafeHtml = row.notes
    ? h`<h3>Notes from submitter</h3><p>${row.notes}</p>`
    : raw("");

  const eahId = formatEahId(row.eah_number);

  const chatBlock: SafeHtml = h`
    <h3>Conversation with submitter</h3>
    ${messages.length === 0
      ? h`<p class="muted"><em>No messages yet.</em></p>`
      : h`<ol class="chat-thread">
          ${messages.map((m) => {
            const who =
              m.sender_type === "staff"
                ? h`<strong>reviewer${m.sender_admin_username ? h` ${m.sender_admin_username}` : raw("")}</strong>`
                : m.sender_type === "user"
                ? h`<strong>submitter</strong>`
                : h`<em>system</em>`;
            return h`<li class="chat-message chat-${m.sender_type}">
              <div class="chat-meta">${who} · ${dt(m.created_at)}</div>
              <div class="chat-body">${m.body}</div>
            </li>`;
          })}
        </ol>`}
    <form method="post" action="/admin/queue/${row.id}/message">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <p>
        <label for="message">Post a message to the submitter</label><br>
        <textarea id="message" name="message" rows="4" cols="80" maxlength="4000"
                  placeholder="Ask for clarification, request a revision, explain a decision…"></textarea>
      </p>
      <p>
        <button type="submit">Post message</button>
        <small class="muted">If the submitter gave an email, they'll be notified.</small>
      </p>
    </form>
  `;

  const entryStatusToggle: SafeHtml = row.status === "published" && eahId
    ? h`
        <h3>Entry status (Active / Patched)</h3>
        <form method="post" action="/admin/entries/${eahId}/status">
          <input type="hidden" name="_csrf" value="${csrfToken}">
          <p>Currently: <strong>${row.entry_status}</strong>.</p>
          <p>
            <button name="entry_status" value="active" type="submit"
                    ${row.entry_status === "active" ? raw('disabled') : raw('')}>Mark active</button>
            <button name="entry_status" value="patched" type="submit"
                    ${row.entry_status === "patched" ? raw('disabled') : raw('')}>Mark patched</button>
          </p>
        </form>
        <p><a href="/admin/entries/${eahId}/edit">Edit this entry's content →</a></p>
      `
    : raw("");

  const reviewerNotesPrev = row.reviewer_notes ?? "";
  const rejectionReasonPrev = row.rejection_reason ?? "";
  const staffReviewMessagePrev = row.staff_review_message ?? "";
  const verifiedHitsPrev = row.verified_hits ?? "";
  const verifiedTotalPrev = row.verified_total ?? "";

  const body = h`
    <p><a href="/admin/queue">← back to queue</a></p>

    <dl class="meta">
      <dt>EAH ID</dt><dd><code>${eahId || raw("<em>(none)</em>")}</code></dd>
      <dt>title</dt><dd>${row.title ?? h`<em>(no title)</em>`}</dd>
      <dt>status</dt><dd>${statusBadge(row.status)}</dd>
      <dt>entry status</dt><dd>${row.entry_status}</dd>
      <dt>model</dt><dd>${row.ai_model ?? "—"}</dd>
      <dt>category</dt><dd>${categoryLabel(row.category)}</dd>
      <dt>author</dt><dd>${row.author_name ?? "anonymous"}</dd>
      <dt>author edits</dt><dd>${row.allow_author_edits ? "allowed" : "not allowed"}</dd>
      <dt>email</dt><dd>${row.submitter_email ? h`<code>${row.submitter_email}</code>` : h`<em>none</em>`}</dd>
      <dt>submitted</dt><dd>${fmtDate(row.submitted_at)}</dd>
      <dt>hallucination date</dt><dd>${row.hallucination_date ?? h`<em>(unspecified)</em>`}</dd>
      <dt>tags</dt><dd>${tagsHtml}</dd>
      <dt>shared chat</dt><dd>${row.shared_chat_url ? h`<a href="${row.shared_chat_url}" rel="nofollow noopener noreferrer">${row.shared_chat_url}</a>` : "—"}</dd>
      <dt>ip-hash prefix</dt><dd><code>${ipPrefix}</code> <small>(triage only)</small></dd>
      ${row.reviewed_at ? h`<dt>reviewed</dt><dd>${fmtDate(row.reviewed_at)}</dd>` : raw("")}
    </dl>

    ${alreadyReviewed}

    ${summaryHtml}
    ${notesHtml}

    <h3>Prompt</h3>
    <pre class="prompt">${row.prompt}</pre>

    <h3>Output</h3>
    <pre class="output">${row.output}</pre>

    ${chatBlock}

    <h3>Review</h3>
    <form method="post" action="/admin/queue/${row.id}">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <p>
        <label for="verified_hits">Verified hits</label>
        <input type="number" id="verified_hits" name="verified_hits"
               min="0" max="999" value="${verifiedHitsPrev}">
        <label for="verified_total" style="margin-left:1em">of total tries</label>
        <input type="number" id="verified_total" name="verified_total"
               min="0" max="999" value="${verifiedTotalPrev}">
        <br><small class="muted">"prompt reproduced N/M times when staff tried it"</small>
      </p>
      <p>
        <label for="reviewer_notes">Reviewer notes (private)</label><br>
        <textarea id="reviewer_notes" name="reviewer_notes" rows="3" cols="80"
                  maxlength="4000">${reviewerNotesPrev}</textarea>
      </p>
      <p>
        <label for="rejection_reason">Rejection reason (shown to submitter on /track and in the rejection email)</label><br>
        <textarea id="rejection_reason" name="rejection_reason" rows="3" cols="80"
                  maxlength="1000">${rejectionReasonPrev}</textarea>
      </p>
      <p>
        <label for="staff_review_message">Staff review message
          (emailed to the submitter on accept/reject; also shown on /track)</label><br>
        <textarea id="staff_review_message" name="staff_review_message" rows="4" cols="80"
                  maxlength="4000">${staffReviewMessagePrev}</textarea>
      </p>
      <p>
        <button name="action" value="approve" type="submit">Approve and publish</button>
        <button name="action" value="reject" type="submit">Reject (frees A-number)</button>
      </p>
    </form>

    ${entryStatusToggle}
  `;

  const html = layout({
    title: `Submission #${row.id}`,
    heading: `${eahId || "(unnumbered)"} — ${row.title ?? "(no title)"} ${statusBadge(row.status)}`,
    body,
    admin: { username: ctx.admin.username, csrfToken },
  });
  return htmlResponse(html, { setCookie: csrfSetCookie });
}

function notFound(ctx: RouteContext): Response {
  const body = layout({
    title: "Not found",
    heading: "Submission not found",
    body: h`<p>No submission with that id. <a href="/admin/queue">Back to queue</a>.</p>`,
    admin: ctx.admin ? { username: ctx.admin.username } : null,
  });
  return htmlResponse(body, { status: 404 });
}
