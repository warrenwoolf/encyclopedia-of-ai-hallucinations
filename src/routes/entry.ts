/**
 * GET /e/:public_id — single published entry page.
 *
 * Accepts either the canonical A-number ("A000123") OR the legacy random
 * public_id slug (kept for back-compat with any URL that was shared while
 * the old scheme was live). When matched by public_id, 301-redirects to the
 * canonical A-number URL.
 */
import { h, raw } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { queryOne, query } from "../db.ts";
import { categoryLabel } from "../categories.ts";
import { config } from "../config.ts";
import { formatEahId, parseEahId } from "../eah-id.ts";
import { tokenForRequest } from "../csrf.ts";
import { COMPLAINT_TYPES } from "./complaint.ts";
import { normalizeMode, effectiveTurns, renderConversation } from "../turns.ts";
import { loadTurns } from "../turns-db.ts";
import { longField } from "./browse.ts";
import { type RouteHandler } from "./types.ts";

interface SubmissionRow {
  id: number;
  public_id: string;
  eah_number: number | null;
  title: string | null;
  prompt: string;
  output: string;
  ai_model: string;
  summary: string | null;
  notes: string | null;
  shared_chat_url: string | null;
  source_url: string | null;
  category: string;
  entry_status: "active" | "patched";
  repro_status: string;
  hallucination_date: string | null;
  author_name: string | null;
  owner_user_id: number | null;
  anon_public: number;
  owner_username: string | null;
  submitted_at: Date;
  verified_hits: number | null;
  verified_total: number | null;
  status: string;
  transcript_mode: string;
}

/** Public entry tiers (everything else — draft/rejected/withdrawn — 404s).
 * `unreviewed` = pending review; `reviewed` = pending acceptance or active. */
const PUBLIC_STATUSES = new Set(["unreviewed", "reviewed"]);

function ymd(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function notFound(req: Request, ctx: { user: any }): Promise<Response> {
  const body = h`<p>No entry with that ID, or it isn't public.</p>
    <p><a href="/browse">Browse entries</a> · <a href="/">Home</a></p>`;
  return pageResponse(
    req,
    { title: "Not found · ENAIH", heading: "Not found", body, user: ctx.user },
    { status: 404 },
  );
}

export const entry: RouteHandler = async (req, ctx) => {
  const idParam = ctx.params.public_id;
  if (!idParam || !/^[A-Za-z0-9_-]{1,32}$/.test(idParam)) {
    return await notFound(req, ctx);
  }

  // First try the A-number (canonical). If the param doesn't look like one,
  // fall back to the legacy public_id slug.
  const COLS = `id, public_id, eah_number, title, prompt, output, ai_model, summary, notes,
              shared_chat_url, source_url, category, entry_status, repro_status, hallucination_date,
              author_name, owner_user_id, anon_public,
              submitted_at, verified_hits, verified_total, status, transcript_mode`;
  let row: SubmissionRow | undefined;
  const eahNum = parseEahId(idParam);
  if (eahNum !== null) {
    row = await queryOne<SubmissionRow>(
      `SELECT ${COLS} FROM submissions WHERE eah_number = ?`,
      [eahNum],
    );
  } else {
    row = await queryOne<SubmissionRow>(
      `SELECT ${COLS} FROM submissions WHERE public_id = ?`,
      [idParam],
    );
    // 301 to the canonical A-number URL. Every non-draft entry now has one
    // (allocated at submit-for-review), so the slug always redirects to it.
    if (row && PUBLIC_STATUSES.has(row.status) && row.eah_number !== null) {
      const canonical = `/e/${formatEahId(row.eah_number)}`;
      return new Response(null, { status: 301, headers: { Location: canonical } });
    }
  }

  if (!row || !PUBLIC_STATUSES.has(row.status)) {
    return await notFound(req, ctx);
  }

  // Public attribution: the submitter's account username, unless they opted to
  // be anonymous to the public. Owner-less entries (legacy / staff-created
  // direct entries) fall back to the free-text author_name.
  const ownerUsername = row.owner_user_id
    ? (await queryOne<{ username: string }>(
        "SELECT username FROM users WHERE id = ?",
        [row.owner_user_id],
      ))?.username ?? null
    : null;
  const authorDisplay = row.anon_public === 1
    ? h`<em>anonymous</em>`
    : ownerUsername
      ? h`${ownerUsername}`
      : (row.author_name && row.author_name.length > 0 ? h`${row.author_name}` : h`<em>anonymous</em>`);

  const tagRows = await query<{ name: string }>(
    `SELECT t.name
       FROM tags t
       JOIN submission_tags st ON st.tag_id = t.id
       WHERE st.submission_id = ?
       ORDER BY t.name ASC`,
    [row.id],
  );

  // Prev/next navigation within the active canon only. Every non-draft now
  // carries an A-number, but the pending tiers (pending review / pending
  // acceptance) aren't part of the public sequence, so they get no prev/next.
  const numbered = row.repro_status === "reproduced" && row.eah_number !== null;
  const prevRow = numbered ? await queryOne<{ eah_number: number }>(
    `SELECT eah_number FROM submissions WHERE repro_status='reproduced' AND eah_number < ? ORDER BY eah_number DESC LIMIT 1`,
    [row.eah_number],
  ) : undefined;
  const nextRow = numbered ? await queryOne<{ eah_number: number }>(
    `SELECT eah_number FROM submissions WHERE repro_status='reproduced' AND eah_number > ? ORDER BY eah_number ASC LIMIT 1`,
    [row.eah_number],
  ) : undefined;

  const tagList = tagRows.length === 0
    ? h`<em>none</em>`
    : h`${tagRows.map((t, i) => h`${i > 0 ? ", " : ""}<a href="/browse?tag=${t.name}">${t.name}</a>`)}`;

  const summaryBlock = row.summary && row.summary.trim().length > 0
    ? h`<section><h2>Summary</h2><p>${row.summary}</p></section>`
    : raw("");

  const notesBlock = row.notes && row.notes.trim().length > 0
    ? h`<section><h2>Notes</h2><p>${row.notes}</p></section>`
    : raw("");

  const sharedChatBlock = row.shared_chat_url && row.shared_chat_url.trim().length > 0
    ? h`<section><h2>View original conversation</h2>
        <p><a href="${row.shared_chat_url}" rel="nofollow noopener noreferrer">${row.shared_chat_url}</a></p>
      </section>`
    : raw("");

  const mode = normalizeMode(row.transcript_mode);
  const isLink = mode === "link";
  // Load the conversation. Legacy/'single' rows have no turn rows, so
  // effectiveTurns() synthesizes a [prompt, output] pair for uniform rendering.
  // 'link' rows have no conversation at all (source + summary carry the entry).
  const storedTurns = isLink ? [] : await loadTurns(row.id);
  const convoTurns = effectiveTurns(mode, storedTurns, row.prompt, row.output);
  // Full conversation, never collapsed at the wrapper level (each long turn
  // still clamps individually via longField).
  const conversation = renderConversation(convoTurns, longField, 0);

  const eahId = formatEahId(row.eah_number);
  const slug = row.public_id;
  // URL ref: A-number (every non-draft has one), else the public_id slug.
  const ref = eahId || slug;

  // Source block for link / social-media submissions.
  const sourceBlock = isLink && row.source_url
    ? h`<section><h2>Source</h2>
        <p><a href="${row.source_url}" rel="nofollow noopener noreferrer">${row.source_url}</a></p>
      </section>`
    : raw("");

  // Trust-tier banner. Active entries are the canon and get no banner; every
  // lower tier carries an honest "not fully verified" note.
  const tierBanner = (() => {
    if (row.repro_status === "reproduced") return raw("");
    let msg;
    if (row.status === "unreviewed") {
      msg = h`<strong>⚠ Pending review.</strong> This submission is public but
        hasn't been checked by staff yet. Treat it with caution until it's
        reviewed.`;
    } else if (row.repro_status === "failed") {
      msg = h`<strong>⚠ Not accepted.</strong> Staff reviewed this entry but
        could <em>not</em> reproduce the behavior. It's kept as a reported sighting.`;
    } else if (isLink) {
      msg = h`<strong>Pending acceptance.</strong> Staff confirmed this is a
        genuine report. Link submissions can't be staff-reproduced, so they
        aren't promoted to active.`;
    } else {
      msg = h`<strong>Pending acceptance.</strong> Staff confirmed this is a
        genuine submission but haven't reproduced it themselves yet, so it isn't
        active in the canon.`;
    }
    return h`<div class="tier-banner" role="note">${msg}</div>`;
  })();

  // Patched-status banner per the spec.
  const patchedBanner = row.entry_status === "patched"
    ? h`<div class="patched-banner" role="note">
        <strong>⚠ This hallucination has been patched.</strong> The underlying
        model error no longer reproduces in current versions. The entry is
        preserved here as a historical record.
      </div>`
    : raw("");

  // Verification line in the metadata block.
  const verificationLine = row.verified_total !== null
    ? h`<dt>Staff verification</dt><dd>Prompt reproduced ${row.verified_hits ?? 0}/${row.verified_total} times when staff tried it.</dd>`
    : raw("");

  const hallucinationDateLine = row.hallucination_date
    ? h`<dt>Observed on</dt><dd>${row.hallucination_date}</dd>`
    : raw("");

  // Citation block: a copyable line in OEIS style.
  const submittedYmd = ymd(row.submitted_at);
  const citeId = eahId || slug;
  const canonicalUrl = `${config.publicBaseUrl}/e/${ref}`;
  const citationText = `Encyclopedia of AI Hallucinations, entry ${citeId} (${row.title ?? row.ai_model}), submitted ${submittedYmd}. ${canonicalUrl}`;

  // Colored header bar carrying the title (matches the browse-listing cards).
  // The A-number, model, and category now live in the metadata grid below.
  const pageHeader = h`
    <header class="entry-card-head entry-page-head">
      <h1 class="entry-card-title">${row.title ?? row.ai_model}</h1>
      ${row.entry_status === "patched"
        ? h`<span class="entry-badge-patched">patched</span>`
        : raw("")}
    </header>
  `;

  // CSRF token for the "report a problem" form below. pageResponse memoizes
  // per-request, so it will reuse this exact token (and its Set-Cookie).
  const { token: csrfToken } = tokenForRequest(req);

  // After a successful complaint POST we redirect here with ?complaint=ok and
  // show a small confirmation. (Any other value is ignored.)
  const complaintThanks = ctx.url.searchParams.get("complaint") === "ok"
    ? h`<div class="complaint-thanks" role="status">
        Thanks — your report was sent to the staff. We review every report.
      </div>`
    : raw("");

  const complaintForm = h`
    <details class="entry-complaint">
      <summary>Report a problem with this entry</summary>
      <form method="post" action="/e/${ref}/complaint">
        <input type="hidden" name="_csrf" value="${csrfToken}">
        <p>
          <label for="complaint_type">What's wrong?</label><br>
          <select id="complaint_type" name="complaint_type" required>
            ${COMPLAINT_TYPES.map((t) => h`<option value="${t.key}">${t.label}</option>`)}
          </select>
        </p>
        <p>
          <label for="complaint_body">Details</label><br>
          <textarea id="complaint_body" name="body" rows="4" maxlength="2000" required
            placeholder="Briefly describe the problem."></textarea>
        </p>
        <p><button type="submit">Send report</button></p>
      </form>
    </details>
  `;

  const idCell = eahId
    ? h`<code>${eahId}</code>`
    : h`<span class="muted">— (no A-number)</span>`;

  const conversationSection = isLink
    ? raw("")
    : h`<section>
        <h2>${convoTurns.length > 2 ? raw("Conversation") : raw("Prompt &amp; response")}</h2>
        ${conversation}
      </section>`;

  const body = h`
    ${pageHeader}
    ${complaintThanks}
    ${tierBanner}
    ${patchedBanner}

    <dl class="entry-meta">
      <dt>Entry ID</dt><dd>${idCell}</dd>
      <dt>Model</dt><dd>${row.ai_model}</dd>
      <dt>Category</dt><dd>${categoryLabel(row.category)}</dd>
      <dt>Author</dt><dd>${authorDisplay}</dd>
      <dt>Tags</dt><dd>${tagList}</dd>
      <dt>Submitted</dt><dd>${submittedYmd}</dd>
      ${hallucinationDateLine}
      ${verificationLine}
    </dl>

    ${sourceBlock}
    ${conversationSection}

    ${sharedChatBlock}
    ${summaryBlock}
    ${notesBlock}

    <section class="entry-footer-block">
      <h2>Cite this entry</h2>
      <pre class="citation" data-copy-target="true">${citationText}</pre>
      <p><a href="/browse">Browse all entries</a></p>
    </section>

    ${numbered ? h`<nav class="entry-nav">
      ${prevRow
        ? h`<a href="/e/${formatEahId(prevRow.eah_number)}">&larr; ${formatEahId(prevRow.eah_number)}</a>`
        : h`<span class="disabled">&larr; (first)</span>`}
      &middot;
      ${nextRow
        ? h`<a href="/e/${formatEahId(nextRow.eah_number)}">${formatEahId(nextRow.eah_number)} &rarr;</a>`
        : h`<span class="disabled">(last) &rarr;</span>`}
    </nav>` : raw("")}

    ${complaintForm}
  `;

  // Only active canon (reviewed + reproduced) is indexable; lower tiers
  // (pending review/acceptance, failed) are link-reachable but hidden from
  // listings, so keep them out of the index too. canonicalUrl is the A-number
  // form, matching the 301 every slug already redirects to.
  const isActiveCanon = row.repro_status === "reproduced";
  return pageResponse(req, {
    title: `${citeId} · ${row.title ?? row.ai_model} · ENAIH`,
    bodyClass: "text-page",
    body,
    user: ctx.user,
    noindex: !isActiveCanon,
    canonical: isActiveCanon ? canonicalUrl : undefined,
  });
};
