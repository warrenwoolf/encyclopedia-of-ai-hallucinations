/**
 * GET /browse — filterable, paginated listing of published submissions.
 *
 * Supported query params: category, tag, model, q, page.
 * All filters are AND-combined. `q` does LIKE across prompt/output/model/summary
 * using parameterized placeholders only.
 */
import { h, raw } from "../html.ts";
import { layout } from "../layout.ts";
import { query, queryOne } from "../db.ts";
import { CATEGORIES, categoryLabel, isValidCategory } from "../categories.ts";
import { htmlResponse, type RouteHandler } from "./types.ts";

interface Row {
  public_id: string;
  ai_model: string;
  category: string;
  submitted_at: Date;
}

const PAGE_SIZE = 50;

function ymd(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Escape LIKE wildcards in user input so they're treated as literals. */
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function buildQs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === null) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s.length > 0 ? `?${s}` : "";
}

export const browse: RouteHandler = async (_req, ctx) => {
  const sp = ctx.url.searchParams;

  const rawCategory = (sp.get("category") ?? "").trim();
  const category = rawCategory && isValidCategory(rawCategory) ? rawCategory : "";

  const tag = (sp.get("tag") ?? "").trim().toLowerCase().slice(0, 40);
  const tagValid = /^[a-z0-9-]+$/.test(tag) ? tag : "";

  const model = (sp.get("model") ?? "").trim().slice(0, 120);
  const q = (sp.get("q") ?? "").trim().slice(0, 200);

  const pageRaw = parseInt(sp.get("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  // Assemble WHERE clauses + params. We never interpolate user values into SQL.
  const where: string[] = ["s.status = 'published'"];
  const params: unknown[] = [];
  let join = "";

  if (category) {
    where.push("s.category = ?");
    params.push(category);
  }
  if (model) {
    where.push("s.ai_model = ?");
    params.push(model);
  }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push(
      "(s.prompt LIKE ? ESCAPE '\\\\' OR s.output LIKE ? ESCAPE '\\\\' OR s.ai_model LIKE ? ESCAPE '\\\\' OR s.summary LIKE ? ESCAPE '\\\\')",
    );
    params.push(like, like, like, like);
  }
  if (tagValid) {
    join = "JOIN submission_tags st ON st.submission_id = s.id JOIN tags t ON t.id = st.tag_id";
    where.push("t.name = ?");
    params.push(tagValid);
  }

  const whereSql = where.join(" AND ");

  const countRow = await queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT s.id) AS n FROM submissions s ${join} WHERE ${whereSql}`,
    params,
  );
  const totalCount = Number(countRow?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const rows = await query<Row>(
    `SELECT DISTINCT s.public_id, s.ai_model, s.category, s.submitted_at, s.id
       FROM submissions s
       ${join}
       WHERE ${whereSql}
       ORDER BY s.submitted_at DESC, s.id DESC
       LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset],
  );

  const hasFilters = Boolean(category || tagValid || model || q);

  const filterChips: ReturnType<typeof h>[] = [];
  if (category) filterChips.push(h`<span class="chip">category: ${categoryLabel(category)}</span>`);
  if (tagValid) filterChips.push(h`<span class="chip">tag: ${tagValid}</span>`);
  if (model) filterChips.push(h`<span class="chip">model: ${model}</span>`);
  if (q) filterChips.push(h`<span class="chip">search: ${q}</span>`);

  const filtersBlock = hasFilters
    ? h`<div class="filters">
        ${filterChips}
        <a href="/browse" class="clear-filters">clear filters</a>
      </div>`
    : h`<div class="filters"><em>No filters applied.</em></div>`;

  // Category sidebar / quick links
  const categoryLinks = h`<div class="category-links">
    ${CATEGORIES.map(
      (c) => h`<a href="/browse?category=${c.key}">${c.label}</a> `,
    )}
  </div>`;

  // Pagination
  const prevQs = page > 1 ? buildQs({ category, tag: tagValid, model, q, page: page - 1 }) : null;
  const nextQs = page < totalPages ? buildQs({ category, tag: tagValid, model, q, page: page + 1 }) : null;

  const pagination = h`<nav class="pagination">
    ${prevQs ? h`<a href="/browse${raw(prevQs)}">&larr; prev</a>` : h`<span class="disabled">&larr; prev</span>`}
    <span>page ${page} of ${totalPages}</span>
    ${nextQs ? h`<a href="/browse${raw(nextQs)}">next &rarr;</a>` : h`<span class="disabled">next &rarr;</span>`}
  </nav>`;

  const list = rows.length === 0
    ? h`<p><em>No matching entries.</em></p>`
    : h`<ul class="entry-list-compact">
        ${rows.map(
          (r) => h`<li>
            <a href="/e/${r.public_id}">${r.ai_model}</a>
            <span class="meta">[${categoryLabel(r.category)}]</span>
            <span class="meta">${ymd(r.submitted_at)}</span>
          </li>`,
        )}
      </ul>`;

  // Re-display search form pre-filled with current q so people can refine.
  const searchForm = h`<form action="/browse" method="get" class="search-form">
    <input type="search" name="q" value="${q}" placeholder="search prompts, outputs, models..." maxlength="200">
    ${category ? h`<input type="hidden" name="category" value="${category}">` : h``}
    ${tagValid ? h`<input type="hidden" name="tag" value="${tagValid}">` : h``}
    ${model ? h`<input type="hidden" name="model" value="${model}">` : h``}
    <button type="submit">Search</button>
  </form>`;

  const body = h`
    ${searchForm}
    ${filtersBlock}
    ${categoryLinks}
    <p class="result-count">${totalCount} ${totalCount === 1 ? raw("entry") : raw("entries")}</p>
    ${list}
    ${pagination}
  `;

  return htmlResponse(layout({
    title: "Browse · EAH",
    heading: "Browse",
    body,
    admin: ctx.admin,
  }));
};
