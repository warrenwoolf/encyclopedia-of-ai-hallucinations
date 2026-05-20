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
import { htmlResponse, type RouteContext } from "../types.ts";

interface PendingRow {
  id: number;
  public_id: string;
  ai_model: string | null;
  category: string;
  submitted_at: Date;
}

interface SubmissionFull {
  id: number;
  public_id: string;
  prompt: string;
  output: string;
  ai_model: string | null;
  summary: string | null;
  shared_chat_url: string | null;
  category: string;
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
    `SELECT id, public_id, ai_model, category, submitted_at
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
              <th>id</th>
              <th>public id</th>
              <th>model</th>
              <th>category</th>
              <th>submitted</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => h`
              <tr>
                <td>${r.id}</td>
                <td><code>${r.public_id}</code></td>
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
    <p>${rows.length} pending submission${rows.length === 1 ? "" : "s"}.</p>
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
    `SELECT id, public_id, prompt, output, ai_model, summary, shared_chat_url, category, author_name,
            submitter_email, submitted_at, status, reviewed_by, reviewed_at, reviewer_notes,
            staff_review_message, verified_hits, verified_total, rejection_reason, ip_hash
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

  const reviewerNotesPrev = row.reviewer_notes ?? "";
  const rejectionReasonPrev = row.rejection_reason ?? "";
  const staffReviewMessagePrev = row.staff_review_message ?? "";
  const verifiedHitsPrev = row.verified_hits ?? "";
  const verifiedTotalPrev = row.verified_total ?? "";

  const body = h`
    <p><a href="/admin/queue">← back to queue</a></p>

    <dl class="meta">
      <dt>status</dt><dd>${statusBadge(row.status)}</dd>
      <dt>model</dt><dd>${row.ai_model ?? "—"}</dd>
      <dt>category</dt><dd>${categoryLabel(row.category)}</dd>
      <dt>author</dt><dd>${row.author_name ?? "anonymous"}</dd>
      <dt>email</dt><dd>${row.submitter_email ? h`<code>${row.submitter_email}</code>` : h`<em>none</em>`}</dd>
      <dt>submitted</dt><dd>${fmtDate(row.submitted_at)}</dd>
      <dt>tags</dt><dd>${tagsHtml}</dd>
      <dt>shared chat</dt><dd>${row.shared_chat_url ? h`<a href="${row.shared_chat_url}" rel="nofollow noopener noreferrer">${row.shared_chat_url}</a>` : "—"}</dd>
      <dt>ip-hash prefix</dt><dd><code>${ipPrefix}</code> <small>(triage only)</small></dd>
      ${row.reviewed_at ? h`<dt>reviewed</dt><dd>${fmtDate(row.reviewed_at)}</dd>` : raw("")}
    </dl>

    ${alreadyReviewed}

    ${summaryHtml}

    <h3>Prompt</h3>
    <pre class="prompt">${row.prompt}</pre>

    <h3>Output</h3>
    <pre class="output">${row.output}</pre>

    <h3>Review</h3>
    <form method="post" action="/admin/queue/${row.id}">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <p>
        <label for="verified_hits">Verified hits</label>
        <input type="number" id="verified_hits" name="verified_hits"
               min="0" max="999" value="${verifiedHitsPrev}">
        <label for="verified_total" style="margin-left:1em">of total</label>
        <input type="number" id="verified_total" name="verified_total"
               min="0" max="999" value="${verifiedTotalPrev}">
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
        <button name="action" value="reject" type="submit">Reject</button>
      </p>
    </form>
  `;

  const html = layout({
    title: `Submission #${row.id}`,
    heading: `Submission #${row.id} (${row.public_id}) ${statusBadge(row.status)}`,
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
