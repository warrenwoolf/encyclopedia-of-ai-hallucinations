/**
 * Admin queue (pending submissions list + single-submission detail/review).
 *
 *   GET /admin/queue       — list pending submissions
 *   GET /admin/queue/:id   — full submission view with review form
 */
import { h, raw, type SafeHtml } from "../../html.ts";
import { layout } from "../../layout.ts";
import { query, queryOne } from "../../db.ts";
import { CATEGORIES, categoryLabel } from "../../categories.ts";
import { tokenForRequest } from "../../csrf.ts";
import { formatEahId } from "../../eah-id.ts";
import { htmlResponse, type RouteContext } from "../types.ts";
import { findSimilar } from "../../similarity.ts";
import { mayEdit } from "./entries.ts";

/** Jump-to-entry form used in both queue list and detail views. */
const jumpToForm: SafeHtml = h`
  <form class="jump-to-form" method="get" action="/admin/entries/redirect">
    Jump to: <input type="text" name="id" placeholder="A000001" maxlength="10">
    <button type="submit">Go</button>
  </form>
`;

interface PendingRow {
  id: number;
  public_id: string;
  eah_number: number | null;
  title: string | null;
  ai_model: string | null;
  category: string;
  status: string;
  repro_status: string;
  transcript_mode: string;
  submitted_at: Date;
}

/** What staff action this queue row is waiting on. */
function stageLabel(status: string, transcriptMode: string): string {
  if (status === "unreviewed") return "needs review";
  if (transcriptMode === "link") return "reviewed (link — no repro)";
  return "needs reproduction";
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
  owner_user_id: number | null;
  anon_public: number;
  submitter_email: string | null;
  submitted_at: Date;
  status: string;
  repro_status: string;
  transcript_mode: string;
  source_url: string | null;
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

  // Worklist: things awaiting a staff action — unreviewed submissions (need a
  // first-pass review) and reviewed-but-not-yet-reproduced ones (need a repro
  // attempt). Unreviewed first, then by age.
  const rows = await query<PendingRow>(
    `SELECT id, public_id, eah_number, title, ai_model, category, status, repro_status,
            transcript_mode, submitted_at
       FROM submissions
       WHERE status = 'unreviewed'
          OR (status = 'reviewed' AND repro_status = 'pending')
       ORDER BY (status = 'unreviewed') DESC, submitted_at ASC
       LIMIT 1000`,
  );

  const tableBody: SafeHtml = rows.length === 0
    ? h`<p><em>The queue is empty.</em></p>`
    : h`
        <table class="queue">
          <thead>
            <tr>
              <th>ref</th>
              <th>stage</th>
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
                <td><code>${formatEahId(r.eah_number) || `#${r.public_id}`}</code></td>
                <td>${stageLabel(r.status, r.transcript_mode)}</td>
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
    ${jumpToForm}
    <p>${rows.length} submission${rows.length === 1 ? "" : "s"} awaiting action.
       <a href="/admin/entries/new">+ add a new entry directly</a>
       (bypasses the draft queue) ·
       <a href="/admin/categories">manage categories</a>.</p>
    ${tableBody}
  `;

  const html = await layout({
    title: "Admin queue",
    heading: "Pending submissions",
    body,
    user: ctx.user, csrfToken,
    bodyClass: "admin-wide",
  });
  return htmlResponse(html, { setCookie });
}

export async function getQueueDetail(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();

  const idStr = ctx.params.id;
  const id = idStr && /^\d+$/.test(idStr) ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id) || id <= 0) {
    return await notFound(ctx);
  }

  const row = await queryOne<SubmissionFull>(
    `SELECT id, public_id, eah_number, title, prompt, output, ai_model, summary, notes,
            shared_chat_url, source_url, category, entry_status, repro_status, transcript_mode,
            hallucination_date, allow_author_edits,
            author_name, owner_user_id, anon_public, submitter_email, submitted_at, status,
            reviewed_by, reviewed_at, reviewer_notes, staff_review_message,
            verified_hits, verified_total, rejection_reason, ip_hash
       FROM submissions
       WHERE id = ?`,
    [id],
  );
  if (!row) return await notFound(ctx);

  const similarEntries = await findSimilar(row.prompt, row.output, row.id);

  const ownerUsername = row.owner_user_id
    ? (await queryOne<{ username: string }>(
        "SELECT username FROM users WHERE id = ?",
        [row.owner_user_id],
      ))?.username ?? null
    : null;

  const tags = await query<{ name: string }>(
    `SELECT t.name FROM submission_tags st
       JOIN tags t ON t.id = st.tag_id
       WHERE st.submission_id = ?
       ORDER BY t.name ASC`,
    [id],
  );

  const messages = await query<MessageRow>(
    `SELECT m.id, m.sender_type, u.username AS sender_admin_username, m.body, m.created_at
       FROM submission_messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
       WHERE m.submission_id = ?
       ORDER BY m.created_at ASC, m.id ASC`,
    [id],
  );

  const ipPrefix = row.ip_hash
    ? Buffer.from(row.ip_hash).toString("hex").slice(0, 12)
    : "";

  const { token: csrfToken, setCookie: csrfSetCookie } = tokenForRequest(req);

  const alreadyReviewed: SafeHtml = row.status !== "unreviewed"
    ? h`<p class="notice">
        Current tier: <strong>${row.status}${row.status === "reviewed" ? h` / repro: ${row.repro_status}` : raw("")}</strong>${
          row.reviewed_at ? h` (last action ${fmtDate(row.reviewed_at)})` : raw("")
        }.
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

  // Edit affordance follows the same policy the edit handler enforces (mayEdit):
  // owners can always edit; reviewed entries are owner-only; otherwise staff may
  // edit owner-less entries, their own, or ones whose submitter opted in. Queue
  // entries have no A-number, so address the editor by submission id; reproduced
  // canon is addressed by its A-number.
  const editHref = eahId !== ""
    ? `/admin/entries/${eahId}/edit`
    : `/admin/queue/${row.id}/edit`;
  const editLink: SafeHtml = mayEdit(row, ctx)
    ? h`<p><a href="${editHref}">✎ edit this submission's content →</a></p>`
    : row.status === "reviewed"
      ? h`<p class="muted">Reviewed entries can only be edited by an owner.</p>`
      : h`<p class="muted">The submitter hasn't allowed staff to edit this submission.</p>`;

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

  const entryStatusToggle: SafeHtml = row.status === "reviewed" && eahId
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
      `
    : raw("");

  // Action buttons depend on the current tier. Unreviewed → confirm/reject;
  // reviewed-and-pending-repro → reproduce/fail (unless a link) /reject; decided
  // tiers → reject only.
  const reviewActions: SafeHtml = (() => {
    if (row.status === "unreviewed") {
      return h`
        <button name="action" value="confirm" type="submit">Confirm (mark reviewed)</button>
        <button name="action" value="reject" type="submit" class="btn-danger">Reject (delete)</button>`;
    }
    if (row.status === "reviewed" && row.repro_status === "pending") {
      const repro = row.transcript_mode === "link"
        ? h`<span class="muted">Link submission — can't be reproduced (caps at reviewed). </span>`
        : h`<button name="action" value="reproduce" type="submit">Mark reproduced</button>
            <button name="action" value="fail" type="submit">Mark failed to reproduce</button>
            `;
      return h`${repro}<button name="action" value="reject" type="submit" class="btn-danger">Reject (delete)</button>`;
    }
    return h`<span class="muted">This entry is decided (status ${row.status}${
      row.status === "reviewed" ? h` / ${row.repro_status}` : raw("")
    }). </span>
      <button name="action" value="reject" type="submit" class="btn-danger">Reject (delete)</button>`;
  })();

  const reviewerNotesPrev = row.reviewer_notes ?? "";
  const rejectionReasonPrev = row.rejection_reason ?? "";
  const staffReviewMessagePrev = row.staff_review_message ?? "";
  const verifiedHitsPrev = row.verified_hits ?? "";
  const verifiedTotalPrev = row.verified_total ?? "";

  // Version history for this submission.
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
    `SELECT v.*, u.username AS changed_by_username
       FROM submission_versions v
       LEFT JOIN users u ON u.id = v.changed_by
      WHERE v.submission_id = ?
      ORDER BY v.version_num ASC, v.id ASC`,
    [row.id],
  );

  let versionHistoryHtml: SafeHtml;
  if (versionRows.length === 0) {
    versionHistoryHtml = h`<p><em>No edit history recorded.</em></p>`;
  } else {
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
        ? h`${first.changed_by_username}`
        : h`(deleted user)`;
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
          </div>`;
      });
      return h`
        <div class="history-version">
          <div class="history-version-header">#${String(vNum)} · ${byLine} · ${dateStr}</div>
          ${fieldLines}
        </div>`;
    });
    versionHistoryHtml = h`${groupHtml}`;
  }

  const body = h`
    ${jumpToForm}
    <p><a href="/admin/queue">← back to queue</a></p>
    ${editLink}

    <dl class="meta">
      <dt>ENAIH ID</dt><dd><code>${eahId || raw("<em>(none)</em>")}</code></dd>
      <dt>title</dt><dd>${row.title ?? h`<em>(no title)</em>`}</dd>
      <dt>status</dt><dd>${statusBadge(row.status)}</dd>
      <dt>entry status</dt><dd>${row.entry_status}</dd>
      <dt>model</dt><dd>${row.ai_model ?? "—"}</dd>
      <dt>category</dt><dd>${categoryLabel(row.category)}</dd>
      <dt>submitter</dt><dd>${
        ownerUsername ? h`${ownerUsername}` : (row.author_name ? h`${row.author_name}` : h`<em>none</em>`)
      }${row.anon_public ? raw(' <small>(anonymous to public)</small>') : raw("")}</dd>
      <dt>staff edits</dt><dd>${row.allow_author_edits ? "allowed by submitter" : "not allowed by submitter"}</dd>
      ${ctx.owner ? h`<dt>email</dt><dd>${row.submitter_email ? h`<code>${row.submitter_email}</code>` : h`<em>none</em>`}</dd>` : raw("")}
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

    ${similarEntries.length > 0
      ? h`<div class="similar-warning" role="alert">
          <strong>⚠ Possible duplicates detected</strong> — the following published or pending entries have high text overlap with this submission. Review before approving:
          <ul>
            ${similarEntries.map(e => h`
              <li>
                <a href="/e/${formatEahId(e.eah_number)}">${formatEahId(e.eah_number)}</a>
                — ${e.title ?? h`<em>(no title)</em>`}
                (${String(Math.round(e.score * 100))}% overlap)
              </li>
            `)}
          </ul>
        </div>`
      : raw("")}

    ${row.transcript_mode === "link"
      ? h`<h3>Source link</h3>
          <p>${row.source_url
            ? h`<a href="${row.source_url}" rel="nofollow noopener noreferrer">${row.source_url}</a>`
            : h`<em>(no link)</em>`}</p>
          <p class="muted"><small>Link submission — caps at the 'reviewed' tier (no reproduction). The submitter's description is in Summary above.</small></p>`
      : h`<h3>Prompt</h3>
          <pre class="prompt">${row.prompt}</pre>
          <h3>Output</h3>
          <pre class="output">${row.output}</pre>`}

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
        <label for="review_category">Category</label><br>
        <select id="review_category" name="category">
          <option value="" ${row.category ? raw("") : raw("selected")}>-- uncategorized --</option>
          ${CATEGORIES.map((c) => h`<option value="${c.key}" ${c.key === row.category ? raw("selected") : raw("")}>${c.label}</option>`)}
        </select>
        <br><small class="muted">A category is required to confirm. Set it right here —
          no need to open the edit form or ask the submitter for edit consent.
          <a href="/admin/categories">manage categories →</a></small>
      </p>
      <p class="review-actions">
        ${reviewActions}
      </p>
    </form>

    ${entryStatusToggle}

    <h3>Edit history</h3>
    ${versionHistoryHtml}
  `;

  const html = await layout({
    title: `Submission #${row.id}`,
    heading: `${eahId || "(unnumbered)"} — ${row.title ?? "(no title)"} ${statusBadge(row.status)}`,
    body,
    user: ctx.user, csrfToken,
  });
  return htmlResponse(html, { setCookie: csrfSetCookie });
}

async function notFound(ctx: RouteContext): Promise<Response> {
  const body = await layout({
    title: "Not found",
    heading: "Submission not found",
    body: h`<p>No submission with that id. <a href="/admin/queue">Back to queue</a>.</p>`,
    user: ctx.user,
  });
  return htmlResponse(body, { status: 404 });
}
