/**
 * GET / — landing page.
 *
 * Shows a published-count, the 20 most-recent published entries, a category
 * nav, a search form, and a "submit" CTA.
 */
import { h, raw } from "../html.ts";
import { layout } from "../layout.ts";
import { queryOne, query } from "../db.ts";
import { CATEGORIES, categoryLabel } from "../categories.ts";
import { htmlResponse, type RouteHandler } from "./types.ts";

interface RecentRow {
  public_id: string;
  ai_model: string;
  category: string;
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

export const home: RouteHandler = async (_req, ctx) => {
  const countRow = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM submissions WHERE status = 'published'",
  );
  const total = Number(countRow?.n ?? 0);

  const recent = await query<RecentRow>(
    `SELECT public_id, ai_model, category, submitted_at
       FROM submissions
       WHERE status = 'published'
       ORDER BY submitted_at DESC, id DESC
       LIMIT 20`,
  );

  const recentList = recent.length === 0
    ? h`<p><em>No published entries yet.</em></p>`
    : h`<ul class="entry-list">
        ${recent.map(
          (r) => h`<li>
            <a href="/e/${r.public_id}"><code>${r.public_id}</code></a>
            — ${r.ai_model}
            <span class="meta">[${categoryLabel(r.category)}]</span>
            <span class="meta">${ymd(r.submitted_at)}</span>
          </li>`,
        )}
      </ul>`;

  const categoryNav = h`<nav class="category-nav">
    <strong>Categories:</strong>
    ${CATEGORIES.map(
      (c) => h`<a href="/browse?category=${c.key}">${c.label}</a> `,
    )}
  </nav>`;

  const body = h`
    <p>An OEIS-style catalog of LLM hallucinations. There ${total === 1 ? raw("is") : raw("are")}
       currently <strong>${total}</strong> published ${total === 1 ? raw("entry") : raw("entries")}.</p>

    <form action="/browse" method="get" class="search-form">
      <input type="search" name="q" placeholder="search prompts, outputs, models..." maxlength="200">
      <button type="submit">Search</button>
    </form>

    <p><a class="cta" href="/submit">Submit a hallucination</a></p>

    ${categoryNav}

    <h2>Recently published</h2>
    ${recentList}
  `;

  return htmlResponse(layout({
    title: "Encyclopedia of AI Hallucinations",
    body,
    admin: ctx.admin,
  }));
};
