/**
 * GET /browse — filterable, sortable, paginated listing of published submissions.
 *
 * Supported query params:
 *   - category, tag, model, q   (filters)
 *   - status                    (entry_status: 'active' | 'patched')
 *   - sort                      ('new' | 'old' | 'verified' | 'id')
 *   - page
 *
 * All filters are AND-combined. `q` does LIKE across title/prompt/output/model/
 * summary using parameterized placeholders only.
 */
import { h, raw, type SafeHtml } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { query, queryOne } from "../db.ts";
import { CATEGORIES, categoryLabel, isValidCategory, resolveCategory } from "../categories.ts";
import { formatEahId } from "../eah-id.ts";
import { type RouteContext, type RouteHandler } from "./types.ts";

interface Row {
  id: number;
  public_id: string;
  eah_number: number | null;
  title: string | null;
  ai_model: string;
  category: string;
  entry_status: "active" | "patched";
  submitted_at: Date;
  verified_hits: number | null;
  verified_total: number | null;
  prompt: string;
  output: string;
}

/**
 * Render a long text field (prompt/output). Short text shows inline; long text
 * is height-clamped with a pure-HTML <details> "show all" toggle — no JS, no
 * content duplication (the same <pre> just un-clamps when expanded).
 */
function longField(text: string): SafeHtml {
  const isLong = text.length > 600 || text.split("\n").length > 12;
  if (!isLong) return h`<pre class="note">${text}</pre>`;
  return h`<details class="longtext">
    <summary><span class="more">show all</span><span class="less">show less</span></summary>
    <pre class="note">${text}</pre>
  </details>`;
}

const PAGE_SIZE = 25;

type SortKey = "new" | "old" | "verified" | "id";

function sortClause(sort: SortKey): string {
  switch (sort) {
    case "old":      return "s.submitted_at ASC, s.id ASC";
    case "verified": return "(COALESCE(s.verified_hits,0) / NULLIF(s.verified_total,0)) DESC, s.verified_total DESC, s.submitted_at DESC";
    case "id":       return "s.eah_number ASC";
    case "new":
    default:         return "s.submitted_at DESC, s.id DESC";
  }
}

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

/**
 * Build the browse body (search form, filters, controls, listing, pagination).
 * Shared by GET /browse and the home page so both render identically from the
 * search section down.
 */
export async function renderBrowseBody(ctx: RouteContext): Promise<SafeHtml> {
  const sp = ctx.url.searchParams;

  const rawCategory = (sp.get("category") ?? "").trim();
  let category = rawCategory && isValidCategory(rawCategory) ? rawCategory : "";

  const tag = (sp.get("tag") ?? "").trim().toLowerCase().slice(0, 40);
  const tagValid = /^[a-z0-9-]+$/.test(tag) ? tag : "";

  const model = (sp.get("model") ?? "").trim().slice(0, 120);
  let q = (sp.get("q") ?? "").trim().slice(0, 200);

  // The search box doubles as a category filter: if there's no explicit
  // category and the query names one, treat it as a category filter instead of
  // a text search (an alternative to clicking the category buttons).
  if (!category && q) {
    const resolved = resolveCategory(q);
    if (resolved) {
      category = resolved;
      q = "";
    }
  }

  // Fetch all distinct model names for the model filter dropdown.
  const allModels = await query<{ ai_model: string }>(
    `SELECT DISTINCT ai_model FROM submissions WHERE status='published' ORDER BY ai_model ASC`,
  );

  const statusRaw = (sp.get("status") ?? "").trim();
  const status: "" | "active" | "patched" =
    statusRaw === "active" || statusRaw === "patched" ? statusRaw : "";

  const sortRaw = (sp.get("sort") ?? "new").trim();
  const sort: SortKey =
    sortRaw === "old" || sortRaw === "verified" || sortRaw === "id" ? sortRaw : "new";

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
  if (status) {
    where.push("s.entry_status = ?");
    params.push(status);
  }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    // MariaDB requires ESCAPE '\\' in SQL (two backslashes). In a JS string literal,
    // each backslash must be doubled, so '\\\\' in JS → '\\' in SQL → correct ESCAPE clause.
    where.push(
      "(s.title LIKE ? ESCAPE '\\\\' OR s.prompt LIKE ? ESCAPE '\\\\' OR s.output LIKE ? ESCAPE '\\\\' OR s.ai_model LIKE ? ESCAPE '\\\\' OR s.summary LIKE ? ESCAPE '\\\\')",
    );
    params.push(like, like, like, like, like);
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
    `SELECT DISTINCT s.id, s.public_id, s.eah_number, s.title, s.ai_model, s.category, s.entry_status,
            s.submitted_at, s.verified_hits, s.verified_total, s.prompt, s.output
       FROM submissions s
       ${join}
       WHERE ${whereSql}
       ORDER BY ${sortClause(sort)}
       LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset],
  );

  // Fetch tags for the rows on this page in one query, keyed by submission id.
  const tagsByRow = new Map<number, string[]>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const tagRows = await query<{ submission_id: number; name: string }>(
      `SELECT st.submission_id, t.name
         FROM submission_tags st JOIN tags t ON t.id = st.tag_id
        WHERE st.submission_id IN (${placeholders})
        ORDER BY t.name ASC`,
      ids,
    );
    for (const tr of tagRows) {
      const arr = tagsByRow.get(tr.submission_id) ?? [];
      arr.push(tr.name);
      tagsByRow.set(tr.submission_id, arr);
    }
  }

  const hasFilters = Boolean(category || tagValid || model || q || status);

  const filterChips: ReturnType<typeof h>[] = [];
  if (category) filterChips.push(h`<span class="chip">category: ${categoryLabel(category)}</span>`);
  if (tagValid) filterChips.push(h`<span class="chip">tag: ${tagValid}</span>`);
  if (model) filterChips.push(h`<span class="chip">model: ${model}</span>`);
  if (status) filterChips.push(h`<span class="chip">status: ${status}</span>`);
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

  const sharedQs = { category, tag: tagValid, model, q, status, sort };

  const sortLink = (key: SortKey, label: string) => {
    const active = key === sort;
    if (active) return h`<strong>${label}</strong>`;
    const qs = buildQs({ ...sharedQs, sort: key });
    return h`<a href="/browse${raw(qs)}">${label}</a>`;
  };

  const statusLink = (s: "" | "active" | "patched", label: string) => {
    const active = s === status;
    if (active) return h`<strong>${label}</strong>`;
    const qs = buildQs({ ...sharedQs, status: s });
    return h`<a href="/browse${raw(qs)}">${label}</a>`;
  };

  const controlsBar = h`<p class="browse-controls">
    <span><strong>Status:</strong> ${statusLink("", "all")} ·
      ${statusLink("active", "active")} ·
      ${statusLink("patched", "patched")}</span>
    &nbsp;|&nbsp;
    <span><strong>Sort:</strong> ${sortLink("new", "newest")} ·
      ${sortLink("old", "oldest")} ·
      ${sortLink("verified", "most verified")} ·
      ${sortLink("id", "by A-number")}</span>
  </p>`;

  // Pagination — spec §5l format: "← prev · showing 26–50 of 1163 entries · next →"
  const prevQs = page > 1 ? buildQs({ ...sharedQs, page: page - 1 }) : null;
  const nextQs = page < totalPages ? buildQs({ ...sharedQs, page: page + 1 }) : null;
  const rangeStart = offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, totalCount);

  const pagination = h`<nav class="pagination">
    ${prevQs ? h`<a href="/browse${raw(prevQs)}">&larr; prev</a>` : h`<span class="disabled">&larr; prev</span>`}
    &middot;
    <span>showing ${rangeStart}–${rangeEnd} of ${totalCount} ${totalCount === 1 ? raw("entry") : raw("entries")}</span>
    &middot;
    ${nextQs ? h`<a href="/browse${raw(nextQs)}">next &rarr;</a>` : h`<span class="disabled">next &rarr;</span>`}
  </nav>`;

  const prop = (label: string, value: SafeHtml): SafeHtml => h`
    <div class="entry-prop">
      <span class="prop-label">${label}</span>
      <div class="prop-value">${value}</div>
    </div>`;

  const list = rows.length === 0
    ? h`<p><em>No matching entries.</em></p>`
    : h`<ul class="entry-list">
        ${rows.map((r) => {
          const eahId = formatEahId(r.eah_number);
          const linkTarget = eahId ? `/e/${eahId}` : `/e/${r.public_id}`;
          const verifText = r.verified_total !== null
            ? `${r.verified_hits ?? 0}/${r.verified_total}`
            : "—";
          const tags = tagsByRow.get(r.id) ?? [];
          return h`<li class="entry-item">
            <div class="entry-head">
              <a href="${linkTarget}"><code>${eahId || r.public_id}</code></a> —
              <a href="${linkTarget}">${r.title ?? h`<em>(untitled)</em>`}</a>
              ${r.entry_status === "patched"
                ? h`<span class="entry-status entry-status-patched">patched</span>`
                : raw("")}
            </div>
            <div class="entry-props">
              ${prop("Model", h`${r.ai_model}`)}
              ${prop("Category", h`${categoryLabel(r.category)}`)}
              ${prop("Date", h`${ymd(r.submitted_at)}`)}
              ${prop("Verified", h`${verifText}`)}
              ${tags.length > 0
                ? prop("Tags", h`${tags.map((t, i) => h`${i > 0 ? raw(", ") : raw("")}<a href="/browse?tag=${t}">${t}</a>`)}`)
                : raw("")}
              ${prop("Prompt", longField(r.prompt))}
              ${prop("Response", longField(r.output))}
            </div>
          </li>`;
        })}
      </ul>`;

  // Model filter dropdown, populated from distinct published ai_model values.
  const modelOptions = h`<option value="">all models</option>
    ${allModels.map((m) => h`<option value="${m.ai_model}" ${m.ai_model === model ? raw("selected") : raw("")}>${m.ai_model}</option>`)}`;

  // Re-display search form pre-filled with current q so people can refine.
  // The query box + Search button share one full-width row; the model filter
  // sits on its own row below.
  const searchForm = h`<form action="/browse" method="get" class="search-form">
    <div class="search-row">
      <input type="search" name="q" value="${q}" placeholder="search titles, prompts, outputs, models..." maxlength="200">
      <button type="submit">Search</button>
    </div>
    ${category ? h`<input type="hidden" name="category" value="${category}">` : h``}
    ${tagValid ? h`<input type="hidden" name="tag" value="${tagValid}">` : h``}
    ${status ? h`<input type="hidden" name="status" value="${status}">` : h``}
    ${sort !== "new" ? h`<input type="hidden" name="sort" value="${sort}">` : h``}
    <div class="search-model">
      <label for="model-filter">Model: </label>
      <select id="model-filter" name="model">
        ${modelOptions}
      </select>
    </div>
  </form>`;

  return h`
    ${searchForm}
    ${filtersBlock}
    ${categoryLinks}
    ${controlsBar}
    <p class="result-count">${totalCount} ${totalCount === 1 ? raw("entry") : raw("entries")}</p>
    ${list}
    ${pagination}
  `;
}

export const browse: RouteHandler = async (req, ctx) => {
  const body = await renderBrowseBody(ctx);
  return pageResponse(req, {
    title: "Browse · EAH",
    heading: "Browse",
    body,
    user: ctx.user,
  });
};
