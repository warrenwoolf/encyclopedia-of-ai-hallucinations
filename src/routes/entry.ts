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
  category: string;
  entry_status: "active" | "patched";
  hallucination_date: string | null;
  author_name: string | null;
  submitted_at: Date;
  verified_hits: number | null;
  verified_total: number | null;
  status: string;
}

function ymd(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function notFound(req: Request, ctx: { user: any }): Response {
  const body = h`<p>No entry with that ID, or it isn't published.</p>
    <p><a href="/browse">Browse entries</a> · <a href="/">Home</a></p>`;
  return pageResponse(
    req,
    { title: "Not found · EAH", heading: "Not found", body, user: ctx.user },
    { status: 404 },
  );
}

export const entry: RouteHandler = async (req, ctx) => {
  const idParam = ctx.params.public_id;
  if (!idParam || !/^[A-Za-z0-9_-]{1,32}$/.test(idParam)) {
    return notFound(req, ctx);
  }

  // First try the A-number (canonical). If the param doesn't look like one,
  // fall back to the legacy public_id slug.
  let row: SubmissionRow | undefined;
  const eahNum = parseEahId(idParam);
  if (eahNum !== null) {
    row = await queryOne<SubmissionRow>(
      `SELECT id, public_id, eah_number, title, prompt, output, ai_model, summary, notes,
              shared_chat_url, category, entry_status, hallucination_date,
              author_name, submitted_at, verified_hits, verified_total, status
         FROM submissions
         WHERE eah_number = ?`,
      [eahNum],
    );
  } else {
    row = await queryOne<SubmissionRow>(
      `SELECT id, public_id, eah_number, title, prompt, output, ai_model, summary, notes,
              shared_chat_url, category, entry_status, hallucination_date,
              author_name, submitted_at, verified_hits, verified_total, status
         FROM submissions
         WHERE public_id = ?`,
      [idParam],
    );
    // 301 to the canonical A-number URL if we found it the legacy way.
    if (row && row.status === "published" && row.eah_number !== null) {
      const canonical = `/e/${formatEahId(row.eah_number)}`;
      return new Response(null, { status: 301, headers: { Location: canonical } });
    }
  }

  if (!row || row.status !== "published") {
    return notFound(req, ctx);
  }

  const tagRows = await query<{ name: string }>(
    `SELECT t.name
       FROM tags t
       JOIN submission_tags st ON st.tag_id = t.id
       WHERE st.submission_id = ?
       ORDER BY t.name ASC`,
    [row.id],
  );

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

  const eahId = formatEahId(row.eah_number);

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
  const canonicalUrl = `${config.publicBaseUrl}/e/${eahId}`;
  const citationText = `Encyclopedia of AI Hallucinations, entry ${eahId} (${row.title ?? row.ai_model}), submitted ${submittedYmd}. ${canonicalUrl}`;

  const reportUrl = `mailto:${config.email.privacy}?subject=${encodeURIComponent(`EAH issue with ${eahId}`)}`;

  // The big page heading uses the title + AI model. The A-number sits above.
  const pageHeader = h`
    <header class="entry-header">
      <p class="entry-eah-id"><code>${eahId}</code> · <span class="entry-status entry-status-${row.entry_status}">${row.entry_status}</span></p>
      <h1 class="entry-title">${row.title ?? row.ai_model}</h1>
      <p class="entry-category">${row.ai_model} · ${categoryLabel(row.category)}</p>
    </header>
  `;

  const body = h`
    ${pageHeader}
    ${patchedBanner}

    <dl class="entry-meta">
      <dt>Tags</dt><dd>${tagList}</dd>
      <dt>Author</dt><dd>${row.author_name && row.author_name.length > 0 ? row.author_name : h`<em>anonymous</em>`}</dd>
      <dt>Submitted</dt><dd>${submittedYmd}</dd>
      ${hallucinationDateLine}
      ${verificationLine}
    </dl>

    <section>
      <h2>Prompt</h2>
      <pre class="prompt">${row.prompt}</pre>
    </section>

    <section>
      <h2>Model output</h2>
      <pre class="output">${row.output}</pre>
    </section>

    ${sharedChatBlock}
    ${summaryBlock}
    ${notesBlock}

    <section class="entry-footer-block">
      <h2>Cite this entry</h2>
      <pre class="citation">${citationText}</pre>
      <p><a href="${reportUrl}">Report an issue with this entry</a> · <a href="/browse">Browse all entries</a></p>
    </section>
  `;

  return pageResponse(req, {
    title: `${eahId} · ${row.title ?? row.ai_model} · EAH`,
    body,
    user: ctx.user,
  });
};
