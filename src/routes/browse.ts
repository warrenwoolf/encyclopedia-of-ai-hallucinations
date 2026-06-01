/**
 * GET /browse — filterable, sortable, paginated listing of published submissions.
 *
 * Supported query params:
 *   - category, tag, model, q   (filters)
 *   - status                    (entry_status: multi-select 'active' | 'patched')
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
import { formatEahId, parseEahId } from "../eah-id.ts";
import { normalizeMode, effectiveTurns, renderConversation, type Turn } from "../turns.ts";
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
  transcript_mode: string;
  anon_public: number;
  author_name: string | null;
  owner_username: string | null;
}

/**
 * Render a long text field (prompt/output). Short text shows inline; long text
 * is height-clamped with a pure-HTML <details> "show all" toggle — no JS, no
 * content duplication (the same <pre> just un-clamps when expanded).
 */
export function longField(text: string): SafeHtml {
  const isLong = text.length > 600 || text.split("\n").length > 12;
  if (!isLong) return h`<pre class="note">${text}</pre>`;
  return h`<details class="longtext">
    <summary><span class="more">show all</span><span class="less">show less</span></summary>
    <pre class="note">${text}</pre>
  </details>`;
}

/**
 * Render a card's conversation preview. For single-turn (legacy) rows this is
 * the familiar two-box Prompt / Response layout. For multi-turn rows it renders
 * labeled turn boxes, collapsing everything past the first two behind a
 * pure-CSS "show full conversation" <details> so the listing stays cheap.
 */
export function renderCardConversation(
  r: { prompt: string; output: string; transcript_mode: string },
  storedTurns: Turn[],
): SafeHtml {
  const turns = effectiveTurns(normalizeMode(r.transcript_mode), storedTurns, r.prompt, r.output);
  if (turns.length <= 2) {
    // Legacy / simple shape: keep the exact Prompt + Response boxes.
    return h`
      <div class="entry-field">
        <div class="entry-field-label">Prompt</div>
        <div class="entry-field-box">${longField(r.prompt)}</div>
      </div>
      <div class="entry-field">
        <div class="entry-field-label">Response</div>
        <div class="entry-field-box">${longField(r.output)}</div>
      </div>`;
  }
  return renderConversation(turns, longField, 2);
}

const PAGE_SIZE = 25;

// Inline magnifier for the search box's submit button. Constant markup we fully
// control, so it's emitted via raw(). stroke="currentColor" inherits the button
// color (muted, → header-blue on hover).
const SEARCH_ICON =
  `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="12.8" y1="12.8" x2="18" y2="18"/></svg>`;

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

function buildQs(
  params: Record<string, string | number | string[] | undefined>,
): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === null) continue;
    if (Array.isArray(v)) {
      // Repeated key (e.g. ?category=a&category=b) for multi-select filters.
      for (const item of v) if (item !== "") u.append(k, String(item));
    } else {
      u.set(k, String(v));
    }
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

  // Categories are multi-select now: ?category=a&category=b. Validate each
  // against the known set and dedupe (order preserved by the Set).
  const categories = Array.from(
    new Set(
      sp.getAll("category").map((c) => c.trim()).filter((c) => c && isValidCategory(c)),
    ),
  );

  const tag = (sp.get("tag") ?? "").trim().toLowerCase().slice(0, 40);
  const tagValid = /^[a-z0-9-]+$/.test(tag) ? tag : "";

  const model = (sp.get("model") ?? "").trim().slice(0, 120);
  let q = (sp.get("q") ?? "").trim().slice(0, 200);

  // The search box doubles as a category filter: if no category is explicitly
  // selected and the query names one, treat it as a single-category filter
  // instead of a text search (an alternative to ticking the category boxes).
  if (categories.length === 0 && q) {
    const resolved = resolveCategory(q);
    if (resolved) {
      categories.push(resolved);
      q = "";
    }
  }
  const categorySet = new Set(categories);

  // Fetch all distinct model names for the model filter dropdown.
  const allModels = await query<{ ai_model: string }>(
    `SELECT DISTINCT ai_model FROM submissions WHERE status='published' ORDER BY ai_model ASC`,
  );

  const statuses = Array.from(
    new Set(sp.getAll("status").filter((s): s is "active" | "patched" => s === "active" || s === "patched")),
  );
  const statusSet = new Set(statuses);

  const sortRaw = (sp.get("sort") ?? "new").trim();
  const sort: SortKey =
    sortRaw === "old" || sortRaw === "verified" || sortRaw === "id" ? sortRaw : "new";

  const pageRaw = parseInt(sp.get("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  // Assemble WHERE clauses + params. We never interpolate user values into SQL.
  // `base` holds every filter EXCEPT category and entry_status; those two are
  // applied on top per-query so the sidebar can show *faceted* counts — i.e. how
  // many entries each category / status would yield given the other active
  // filters, not a flat global tally.
  const base: string[] = ["s.status = 'published'"];
  const baseParams: unknown[] = [];
  let join = "";

  if (model) {
    base.push("s.ai_model = ?");
    baseParams.push(model);
  }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    // MariaDB requires ESCAPE '\\' in SQL (two backslashes). In a JS string literal,
    // each backslash must be doubled, so '\\\\' in JS → '\\' in SQL → correct ESCAPE clause.
    // Search across every user-visible property: title, prompt, output, model,
    // summary, notes, the public author name, and the owner's username. We do
    // NOT search internal fields (ip_hash, reviewer notes, tracking columns).
    const clauses = [
      "s.title LIKE ? ESCAPE '\\\\'",
      "s.prompt LIKE ? ESCAPE '\\\\'",
      "s.output LIKE ? ESCAPE '\\\\'",
      "s.ai_model LIKE ? ESCAPE '\\\\'",
      "s.summary LIKE ? ESCAPE '\\\\'",
      "s.notes LIKE ? ESCAPE '\\\\'",
      "s.author_name LIKE ? ESCAPE '\\\\'",
      "u.username LIKE ? ESCAPE '\\\\'",
    ];
    const qParams: unknown[] = [like, like, like, like, like, like, like, like];
    // EAH ID search: "A000123", "a123", or a bare number all match eah_number.
    let eahNum = parseEahId(q);
    if (eahNum === null && /^A?\d{1,6}$/i.test(q)) {
      eahNum = parseInt(q.replace(/^[Aa]/, ""), 10);
    }
    if (eahNum !== null) {
      clauses.push("s.eah_number = ?");
      qParams.push(eahNum);
    }
    base.push(`(${clauses.join(" OR ")})`);
    baseParams.push(...qParams);
  }
  if (tagValid) {
    join = "JOIN submission_tags st ON st.submission_id = s.id JOIN tags t ON t.id = st.tag_id";
    base.push("t.name = ?");
    baseParams.push(tagValid);
  }

  const from = `FROM submissions s LEFT JOIN users u ON u.id = s.owner_user_id ${join}`;

  // Multiple selected categories are OR'd among themselves (and AND'd with the
  // other filters) via `s.category IN (...)`.
  const catInClause = categories.length
    ? `s.category IN (${categories.map(() => "?").join(",")})`
    : "";

  const stInClause = statuses.length
    ? `s.entry_status IN (${statuses.map(() => "?").join(",")})`
    : "";

  // Main listing where: base + the two facet filters when set.
  const where = [...base];
  const params: unknown[] = [...baseParams];
  if (catInClause) {
    where.push(catInClause);
    params.push(...categories);
  }
  if (stInClause) {
    where.push(stInClause);
    params.push(...statuses);
  }
  const whereSql = where.join(" AND ");

  // Faceted category counts: base + status (category itself varies), grouped.
  const catWhere = [...base];
  const catParams: unknown[] = [...baseParams];
  if (stInClause) {
    catWhere.push(stInClause);
    catParams.push(...statuses);
  }
  const catCountRows = await query<{ category: string; n: number | bigint }>(
    `SELECT s.category, COUNT(DISTINCT s.id) AS n ${from} WHERE ${catWhere.join(" AND ")} GROUP BY s.category`,
    catParams,
  );
  const catCounts = new Map<string, number>();
  let allCatTotal = 0;
  for (const r of catCountRows) {
    const n = Number(r.n);
    catCounts.set(r.category, n);
    allCatTotal += n;
  }

  // Faceted status counts: base + category (entry_status varies), grouped.
  const stWhere = [...base];
  const stParams: unknown[] = [...baseParams];
  if (catInClause) {
    stWhere.push(catInClause);
    stParams.push(...categories);
  }
  const stCountRows = await query<{ entry_status: string; n: number | bigint }>(
    `SELECT s.entry_status, COUNT(DISTINCT s.id) AS n ${from} WHERE ${stWhere.join(" AND ")} GROUP BY s.entry_status`,
    stParams,
  );
  const statusCounts = new Map<string, number>();
  let allStatusTotal = 0;
  for (const r of stCountRows) {
    const n = Number(r.n);
    statusCounts.set(r.entry_status, n);
    allStatusTotal += n;
  }

  const countRow = await queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT s.id) AS n ${from} WHERE ${whereSql}`,
    params,
  );
  const totalCount = Number(countRow?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const rows = await query<Row>(
    `SELECT DISTINCT s.id, s.public_id, s.eah_number, s.title, s.ai_model, s.category, s.entry_status,
            s.submitted_at, s.verified_hits, s.verified_total, s.prompt, s.output, s.transcript_mode,
            s.anon_public, s.author_name, u.username AS owner_username
       ${from}
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

  // Batch-load turns only for rows that actually have a multi-turn transcript
  // (mode != 'single'), keeping the common case a single tag-only query. Ordered
  // by (submission_id, turn_index) so we can group them in order.
  const turnsByRow = new Map<number, Turn[]>();
  const multiTurnIds = rows.filter((r) => normalizeMode(r.transcript_mode) !== "single").map((r) => r.id);
  if (multiTurnIds.length > 0) {
    const ph = multiTurnIds.map(() => "?").join(",");
    const turnRows = await query<{ submission_id: number; role: "user" | "assistant"; content: string }>(
      `SELECT submission_id, role, content FROM submission_turns
        WHERE submission_id IN (${ph})
        ORDER BY submission_id ASC, turn_index ASC, id ASC`,
      multiTurnIds,
    );
    for (const tr of turnRows) {
      const arr = turnsByRow.get(tr.submission_id) ?? [];
      arr.push({ role: tr.role, content: tr.content });
      turnsByRow.set(tr.submission_id, arr);
    }
  }

  const hasFilters = Boolean(categories.length || tagValid || model || q || statuses.length);

  // `category` and `status` are arrays; buildQs emits one param per selection.
  const sharedQs = { category: categories, tag: tagValid, model, q, status: statuses, sort };

  // Active-filter chips under the results header are *removal* controls: each is
  // a link to the same view with that one filter dropped (a category chip drops
  // just that category; the rest drop their param). browse.js intercepts these
  // so removal is instant; the trailing ✕ + .chip-remove styling signal it.
  const removeChip = (label: string, removeQs: string) =>
    h`<a class="chip chip-remove" href="/browse${raw(removeQs)}" title="Remove this filter">${label}<span class="chip-x" aria-hidden="true">×</span></a>`;
  const filterChips: ReturnType<typeof h>[] = [];
  for (const c of categories) {
    filterChips.push(removeChip(
      `category: ${categoryLabel(c)}`,
      buildQs({ ...sharedQs, category: categories.filter((x) => x !== c) }),
    ));
  }
  if (tagValid) filterChips.push(removeChip(`tag: ${tagValid}`, buildQs({ ...sharedQs, tag: "" })));
  if (model) filterChips.push(removeChip(`model: ${model}`, buildQs({ ...sharedQs, model: "" })));
  for (const s of statuses) {
    filterChips.push(removeChip(`status: ${s}`, buildQs({ ...sharedQs, status: statuses.filter((x) => x !== s) })));
  }
  if (q) filterChips.push(removeChip(`search: ${q}`, buildQs({ ...sharedQs, q: "" })));

  const filtersBlock = hasFilters
    ? h`<div class="filters">
        ${filterChips}
        <a href="/browse" class="clear-filters">clear filters</a>
      </div>`
    : raw("");

  // Category list: multi-select checkboxes inside the filter form. Ticking one
  // adds it (results OR together); the JS in browse.js applies the change
  // without a full reload. "All categories" is a reset link (active when none
  // are ticked) that clears the selection — and still works without JS. Each
  // checkbox carries the field name `category`, so the form submits all ticked
  // ones as repeated params.
  const categoryNav = h`<div class="sidebar-cats count-list">
    <a href="/browse${raw(buildQs({ ...sharedQs, category: [] }))}" class="cat-link cat-reset ${categories.length === 0 ? "active" : ""}">
      <span class="cat-name">All Categories</span><span class="cat-count">( ${allCatTotal} )</span>
    </a>
    ${CATEGORIES.map((c) => {
      const checked = categorySet.has(c.key);
      const n = catCounts.get(c.key) ?? 0;
      return h`<label class="cat-link cat-check ${checked ? "active" : ""}">
        <input type="checkbox" name="category" value="${c.key}" ${checked ? raw("checked") : raw("")}>
        <span class="cat-name">${c.label}</span><span class="cat-count">( ${n} )</span>
      </label>`;
    })}
  </div>`;

  const sortRadio = (key: SortKey, label: string) => {
    const active = key === sort;
    return h`<label class="cat-link cat-check ${active ? "active" : ""}">
      <input type="radio" name="sort" value="${key}" ${active ? raw("checked") : raw("")}>
      <span class="cat-name">${label}</span>
    </label>`;
  };

  const statusCheckRow = (s: "active" | "patched", label: string, count: number) => {
    const checked = statusSet.has(s);
    return h`<label class="cat-link cat-check ${checked ? "active" : ""}">
      <input type="checkbox" name="status" value="${s}" ${checked ? raw("checked") : raw("")}>
      <span class="cat-name">${label}</span><span class="cat-count">( ${count} )</span>
    </label>`;
  };

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

  const infoRow = (label: string, value: SafeHtml): SafeHtml =>
    h`<dt>${label}</dt><dd>${value}</dd>`;

  // Each entry is a collapsible card: the colored header (a <summary>) is the
  // title + collapse toggle; the body holds the info grid plus the prompt and
  // response, which are the focal content (full-width background-filled boxes,
  // no indent). Pure HTML <details> — no JS. Open by default so the listing
  // reads as content; click the header to collapse. The A-number lives in the
  // info grid (it's the permalink), not the header.
  const list = rows.length === 0
    ? h`<p class="empty"><em>No matching entries.</em></p>`
    : h`<ul class="entry-list">
        ${rows.map((r) => {
          const eahId = formatEahId(r.eah_number);
          const linkTarget = eahId ? `/e/${eahId}` : `/e/${r.public_id}`;
          const verifText = r.verified_total !== null
            ? `${r.verified_hits ?? 0}/${r.verified_total}`
            : "—";
          const tags = tagsByRow.get(r.id) ?? [];
          // Same attribution rule as the entry page: account username unless the
          // submitter opted to be anonymous; owner-less rows fall back to the
          // legacy free-text author_name, else "anonymous".
          const author = r.anon_public === 1
            ? h`<em>anonymous</em>`
            : r.owner_username
              ? h`${r.owner_username}`
              : (r.author_name && r.author_name.length > 0 ? h`${r.author_name}` : h`<em>anonymous</em>`);
          return h`<li class="entry-card">
            <details open>
              <summary class="entry-card-head">
                <span class="entry-card-headings">
                  <a class="entry-card-eid" href="${linkTarget}">${eahId || r.public_id}</a>
                  <a class="entry-card-title" href="${linkTarget}">${r.title ?? h`<em>(untitled)</em>`}</a>
                </span>
                ${r.entry_status === "patched"
                  ? h`<span class="entry-badge-patched">patched</span>`
                  : raw("")}
                <span class="entry-card-chevron" aria-hidden="true"></span>
              </summary>
              <div class="entry-card-body">
                <dl class="entry-info">
                  ${infoRow("Author", author)}
                  ${infoRow("Model", h`${r.ai_model}`)}
                  ${infoRow("Category", h`<a href="/browse?category=${r.category}">${categoryLabel(r.category)}</a>`)}
                  ${infoRow("Date", h`${ymd(r.submitted_at)}`)}
                  ${infoRow("Verified", h`${verifText}`)}
                  ${tags.length > 0
                    ? infoRow("Tags", h`${tags.map((t, i) => h`${i > 0 ? raw(", ") : raw("")}<a href="/browse?tag=${t}">${t}</a>`)}`)
                    : raw("")}
                </dl>
                ${renderCardConversation(r, turnsByRow.get(r.id) ?? [])}
              </div>
            </details>
          </li>`;
        })}
      </ul>`;

  // Model filter dropdown, populated from distinct published ai_model values.
  const modelOptions = h`<option value="">all models</option>
    ${allModels.map((m) => h`<option value="${m.ai_model}" ${m.ai_model === model ? raw("selected") : raw("")}>${m.ai_model}</option>`)}`;

  // The whole sidebar is ONE GET form so a no-JS submit (the magnifier button)
  // carries every filter at once. browse.js (progressive enhancement) intercepts
  // changes to apply them without a full page reload and swaps #browse-root.
  // Category is multi-select (checkboxes inside `categoryNav`); status/sort are
  // links that change one value while preserving the rest, so their current
  // values ride along as hidden inputs when the form itself is submitted.
  return h`
    <div class="browse-layout" id="browse-root">
      <aside class="browse-sidebar">
        <form action="/browse" method="get" class="filter-form" data-browse-filters>
          <h2 class="sidebar-title">Refine your search</h2>
          <div class="search-row">
            <input type="search" name="q" value="${q}" placeholder="search title, prompt, output…" maxlength="200">
            <button type="submit" class="search-go" aria-label="Search">${raw(SEARCH_ICON)}</button>
          </div>
          <div class="search-model">
            <label for="model-filter">Model</label>
            <select id="model-filter" name="model">
              ${modelOptions}
            </select>
          </div>
          ${tagValid ? h`<input type="hidden" name="tag" value="${tagValid}">` : h``}
          <div class="sidebar-section">
            <h3 class="sidebar-h">Categories</h3>
            ${categoryNav}
          </div>
          <div class="sidebar-section">
            <h3 class="sidebar-h">Status</h3>
            <div class="sidebar-cats count-list">
              <a href="/browse${raw(buildQs({ ...sharedQs, status: [] }))}" class="cat-link cat-reset ${statuses.length === 0 ? "active" : ""}">
                <span class="cat-name">All Statuses</span><span class="cat-count">( ${allStatusTotal} )</span>
              </a>
              ${statusCheckRow("active", "Active", statusCounts.get("active") ?? 0)}
              ${statusCheckRow("patched", "Patched", statusCounts.get("patched") ?? 0)}
            </div>
          </div>
          <div class="sidebar-section">
            <h3 class="sidebar-h">Sort</h3>
            <div class="sidebar-cats">
              ${sortRadio("new", "Newest")}
              ${sortRadio("old", "Oldest")}
              ${sortRadio("verified", "Most verified")}
              ${sortRadio("id", "By A-number")}
            </div>
          </div>
        </form>
      </aside>
      <div class="browse-main">
        <div class="browse-main-head">
          <h2 class="browse-title">Hallucination Entries</h2>
          <p class="result-count">${totalCount} ${totalCount === 1 ? raw("entry") : raw("entries")}</p>
          ${filtersBlock}
        </div>
        ${list}
        ${pagination}
      </div>
    </div>
  `;
}

export const browse: RouteHandler = async (req, ctx) => {
  const body = await renderBrowseBody(ctx);
  return pageResponse(req, {
    title: "Browse · ENAIH",
    body,
    user: ctx.user,
    bodyClass: "browse-page",
  });
};
