/**
 * Admin "all submissions" listing with status filter and pagination.
 *
 *   GET /admin/all?status=<pending|published|rejected|withdrawn>&page=<n>
 */
import { h, raw, type SafeHtml } from "../../html.ts";
import { layout } from "../../layout.ts";
import { query, queryOne } from "../../db.ts";
import { categoryLabel } from "../../categories.ts";
import { htmlResponse, type RouteContext } from "../types.ts";

const PAGE_SIZE = 100;

const VALID_STATUSES = new Set(["pending", "published", "rejected", "withdrawn"]);

interface Row {
  id: number;
  public_id: string;
  ai_model: string | null;
  category: string;
  status: string;
  submitted_at: Date;
  reviewed_at: Date | null;
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function filterLink(label: string, statusFilter: string | null, current: string | null): SafeHtml {
  const target = statusFilter ? `/admin/all?status=${encodeURIComponent(statusFilter)}` : "/admin/all";
  const active = (statusFilter ?? null) === (current ?? null);
  return active
    ? h`<strong>${label}</strong>`
    : h`<a href="${target}">${label}</a>`;
}

export async function getAll(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) {
    return new Response(null, { status: 303, headers: { Location: "/admin/login" } });
  }

  const rawStatus = ctx.url.searchParams.get("status");
  const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : null;

  const rawPage = ctx.url.searchParams.get("page");
  let page = 1;
  if (rawPage && /^\d{1,6}$/.test(rawPage)) {
    const n = parseInt(rawPage, 10);
    if (n >= 1) page = n;
  }
  const offset = (page - 1) * PAGE_SIZE;

  // Build WHERE / params safely — status is already validated against an allowlist.
  const whereSql = status ? "WHERE status = ?" : "";
  const baseParams: unknown[] = status ? [status] : [];

  const totalRow = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM submissions ${whereSql}`,
    baseParams,
  );
  const total = totalRow?.c ?? 0;

  const rows = await query<Row>(
    `SELECT id, public_id, ai_model, category, status, submitted_at, reviewed_at
       FROM submissions
       ${whereSql}
       ORDER BY submitted_at DESC
       LIMIT ? OFFSET ?`,
    [...baseParams, PAGE_SIZE, offset],
  );

  const filterBar: SafeHtml = h`
    <p class="filterbar">
      Filter:
      ${filterLink("all", null, status)} ·
      ${filterLink("pending", "pending", status)} ·
      ${filterLink("published", "published", status)} ·
      ${filterLink("rejected", "rejected", status)} ·
      ${filterLink("withdrawn", "withdrawn", status)}
    </p>
  `;

  const tableBody: SafeHtml = rows.length === 0
    ? h`<p><em>No submissions match.</em></p>`
    : h`
        <table class="all">
          <thead>
            <tr>
              <th>id</th>
              <th>public id</th>
              <th>model</th>
              <th>category</th>
              <th>status</th>
              <th>submitted</th>
              <th>reviewed</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => h`
              <tr>
                <td>${r.id}</td>
                <td><code>${r.public_id}</code></td>
                <td>${r.ai_model ?? ""}</td>
                <td>${categoryLabel(r.category)}</td>
                <td>[${r.status}]</td>
                <td>${fmtDate(r.submitted_at)}</td>
                <td>${fmtDate(r.reviewed_at)}</td>
                <td><a href="/admin/queue/${r.id}">view →</a></td>
              </tr>
            `)}
          </tbody>
        </table>
      `;

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function pageHref(p: number): string {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/admin/all?${qs}` : "/admin/all";
  }

  const prevLink: SafeHtml = page > 1
    ? h`<a href="${pageHref(page - 1)}">← prev</a>`
    : h`<span class="muted">← prev</span>`;
  const nextLink: SafeHtml = page < lastPage
    ? h`<a href="${pageHref(page + 1)}">next →</a>`
    : h`<span class="muted">next →</span>`;

  const pager: SafeHtml = h`
    <p class="pager">
      ${prevLink} · page ${page} of ${lastPage} (${total} total) · ${nextLink}
    </p>
  `;

  const body = h`
    ${filterBar}
    ${tableBody}
    ${total > 0 ? pager : raw("")}
  `;

  const html = layout({
    title: status ? `All submissions — ${status}` : "All submissions",
    heading: status ? `All submissions — ${status}` : "All submissions",
    body,
    admin: { username: ctx.admin.username },
  });
  return htmlResponse(html);
}
