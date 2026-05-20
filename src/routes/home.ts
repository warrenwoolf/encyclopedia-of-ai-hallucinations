/**
 * GET / — landing page.
 *
 * Shows recent published entries inline (prompt + output truncated past
 * ~1000 chars), a comma-separated category nav, a search form, and a
 * "submit" CTA.
 */
import { h, raw } from "../html.ts";
import { layout } from "../layout.ts";
import { queryOne, query } from "../db.ts";
import { CATEGORIES, categoryLabel } from "../categories.ts";
import { htmlResponse, type RouteHandler } from "./types.ts";

interface RecentRow {
  public_id: string;
  prompt: string;
  output: string;
  ai_model: string;
  category: string;
  submitted_at: Date;
}

const TRUNCATE_AT = 1000;

function ymd(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= TRUNCATE_AT) return { text: s, truncated: false };
  return { text: s.slice(0, TRUNCATE_AT) + "…", truncated: true };
}

export const home: RouteHandler = async (_req, ctx) => {
  const countRow = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM submissions WHERE status = 'published'",
  );
  const total = Number(countRow?.n ?? 0);

  const recent = await query<RecentRow>(
    `SELECT public_id, prompt, output, ai_model, category, submitted_at
       FROM submissions
       WHERE status = 'published'
       ORDER BY submitted_at DESC, id DESC
       LIMIT 20`,
  );

  const recentList = recent.length === 0
    ? h`<p><em>No published entries yet.</em></p>`
    : h`<div class="entry-list">
        ${recent.map((r) => {
          const p = truncate(r.prompt);
          const o = truncate(r.output);
          const fullLink = h`<a href="/e/${r.public_id}">view full entry</a>`;
          return h`<article class="entry-card">
            <h3><a href="/e/${r.public_id}">${r.ai_model}</a>
              <span class="meta">[${categoryLabel(r.category)}] ${ymd(r.submitted_at)}</span>
            </h3>
            <div class="entry-section">
              <div class="entry-label">Prompt</div>
              <pre>${p.text}</pre>
              ${p.truncated ? h`<p class="muted">(prompt truncated — ${fullLink})</p>` : h``}
            </div>
            <div class="entry-section">
              <div class="entry-label">Output</div>
              <pre>${o.text}</pre>
              ${o.truncated ? h`<p class="muted">(output truncated — ${fullLink})</p>` : h``}
            </div>
          </article>`;
        })}
      </div>`;

  const categoryNav = h`<nav class="category-nav">
    <strong>Categories:</strong>
    ${CATEGORIES.map(
      (c, i) => h`${i > 0 ? ", " : ""}<a href="/browse?category=${c.key}">${c.label}</a>`,
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
