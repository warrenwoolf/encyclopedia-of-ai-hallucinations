/**
 * GET /e/:public_id — single published entry page.
 */
import { h, raw } from "../html.ts";
import { layout } from "../layout.ts";
import { queryOne, query } from "../db.ts";
import { categoryLabel } from "../categories.ts";
import { htmlResponse, type RouteHandler } from "./types.ts";

interface SubmissionRow {
  id: number;
  public_id: string;
  prompt: string;
  output: string;
  ai_model: string;
  summary: string | null;
  notes: string | null;
  shared_chat_url: string | null;
  category: string;
  author_name: string | null;
  submitted_at: Date;
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

function notFound(ctx: { admin: any }): Response {
  const body = h`<p>No entry with that ID, or it isn't published.</p>
    <p><a href="/browse">Browse entries</a> · <a href="/">Home</a></p>`;
  return htmlResponse(
    layout({ title: "Not found · EAH", heading: "Not found", body, admin: ctx.admin }),
    { status: 404 },
  );
}

export const entry: RouteHandler = async (_req, ctx) => {
  const publicId = ctx.params.public_id;
  if (!publicId || !/^[A-Za-z0-9_-]{1,32}$/.test(publicId)) {
    return notFound(ctx);
  }

  const row = await queryOne<SubmissionRow>(
    `SELECT id, public_id, prompt, output, ai_model, summary, notes, shared_chat_url, category,
            author_name, submitted_at, status
       FROM submissions
       WHERE public_id = ?`,
    [publicId],
  );

  if (!row || row.status !== "published") {
    return notFound(ctx);
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
    ? h`<section><h2>Shared chat</h2>
        <p><a href="${row.shared_chat_url}" rel="nofollow noopener noreferrer">${row.shared_chat_url}</a></p>
      </section>`
    : raw("");

  // The big page heading uses the AI model and category, not the public_id.
  const pageHeader = h`
    <header class="entry-header">
      <h1 class="entry-model">${row.ai_model}</h1>
      <p class="entry-category">${categoryLabel(row.category)}</p>
    </header>
  `;

  const body = h`
    ${pageHeader}

    <dl class="entry-meta">
      <dt>Tags</dt><dd>${tagList}</dd>
      <dt>Author</dt><dd>${row.author_name && row.author_name.length > 0 ? row.author_name : h`<em>anonymous</em>`}</dd>
      <dt>Submitted</dt><dd>${ymd(row.submitted_at)}</dd>
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
  `;

  return htmlResponse(layout({
    title: `${row.ai_model} · ${categoryLabel(row.category)} · EAH`,
    body,
    admin: ctx.admin,
  }));
};
