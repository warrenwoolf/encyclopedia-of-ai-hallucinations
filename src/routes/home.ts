/**
 * GET / — landing page.
 *
 * Shows recent published entries inline (prompt + output truncated past
 * ~1000 chars), a comma-separated category nav, a search form, and a
 * "submit" CTA.
 */
import { h, raw } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { queryOne, query } from "../db.ts";
import { CATEGORIES, categoryLabel } from "../categories.ts";
import { formatEahId } from "../eah-id.ts";
import { type RouteHandler } from "./types.ts";

interface RecentRow {
  public_id: string;
  eah_number: number | null;
  title: string | null;
  ai_model: string;
  category: string;
  entry_status: "active" | "patched";
  submitted_at: Date;
}

function ymd(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const home: RouteHandler = async (req, ctx) => {
  const countRow = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM submissions WHERE status = 'published'",
  );
  const total = Number(countRow?.n ?? 0);

  const categoryCounts = await query<{ category: string; n: number }>(
    `SELECT category, COUNT(*) AS n FROM submissions WHERE status='published' GROUP BY category ORDER BY n DESC`,
  );

  const recent = await query<RecentRow>(
    `SELECT public_id, eah_number, title, ai_model, category, entry_status, submitted_at
       FROM submissions
       WHERE status = 'published'
       ORDER BY submitted_at DESC, id DESC
       LIMIT 12`,
  );

  const recentList = recent.length === 0
    ? h`<p><em>No published entries yet.</em></p>`
    : h`<table class="recent-table">
        <thead>
          <tr>
            <th>EAH ID</th>
            <th>Title</th>
            <th>Model</th>
            <th>Category</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          ${recent.map((r) => {
            const eahId = formatEahId(r.eah_number);
            // If eah_number is NULL (pre-numbering rows), fall back to legacy
            // public_id slug. formatEahId(null) returns "" which is falsy.
            const url = eahId ? `/e/${eahId}` : `/e/${r.public_id}`;
            return h`<tr>
              <td><a href="${url}"><code>${eahId || r.public_id}</code></a></td>
              <td><a href="${url}">${r.title ?? h`<em>(untitled)</em>`}</a>${
                r.entry_status === "patched"
                  ? h` <span class="entry-status entry-status-patched">patched</span>`
                  : raw("")
              }</td>
              <td>${r.ai_model}</td>
              <td>${categoryLabel(r.category)}</td>
              <td>${ymd(r.submitted_at)}</td>
            </tr>`;
          })}
        </tbody>
      </table>`;

  const categoryNav = h`<nav class="category-nav">
    <strong>Categories:</strong>
    ${CATEGORIES.map(
      (c, i) => h`${i > 0 ? ", " : ""}<a href="/browse?category=${c.key}">${c.label}</a>`,
    )}
  </nav>`;

  // Category counts line: "By category: Fabricated citation (142) · Tokenization (89) · …"
  const categoryCountsLine = categoryCounts.length > 0
    ? h`<p class="category-counts">By category:
        ${categoryCounts.map((row, i) => h`${i > 0 ? raw(" · ") : raw("")}<a href="/browse?category=${row.category}">${categoryLabel(row.category)}</a> (${Number(row.n)})`)}
      </p>`
    : raw("");

  const body = h`
    <div class="home-top">
      <p class="tagline"><em>A community-maintained database of real, reproducible AI hallucinations.</em></p>

      <p>There ${total === 1 ? raw("is") : raw("are")}
         currently <strong>${total}</strong> published ${total === 1 ? raw("entry") : raw("entries")}.</p>

      <form action="/browse" method="get" class="search-form">
        <input type="search" name="q" placeholder="search prompts, outputs, models..." maxlength="200">
        <button type="submit">Search</button>
      </form>

      <p><a class="cta" href="/submit">Submit a hallucination</a></p>

      ${categoryNav}
      ${categoryCountsLine}

      <h2>Recently published</h2>
    </div>
    ${recentList}
  `;

  return pageResponse(req, {
    title: "Encyclopedia of AI Hallucinations",
    body,
    user: ctx.user,
  });
};
