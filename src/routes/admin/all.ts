/**
 * Admin "all submissions" listing with status filter and pagination.
 *
 *   GET /admin/all?status=<pending|published|rejected|withdrawn>&page=<n>
 */
import { h, raw, type SafeHtml } from "../../html.ts";
import { layout } from "../../layout.ts";
import { query, queryOne, execute } from "../../db.ts";
import { categoryLabel } from "../../categories.ts";
import { tokenForRequest, verifyCsrf } from "../../csrf.ts";
import { formatEahId } from "../../eah-id.ts";
import { htmlResponse, parseForm, type RouteContext } from "../types.ts";

const PAGE_SIZE = 100;

const VALID_STATUSES = new Set(["pending", "published", "rejected", "withdrawn"]);

interface Row {
  id: number;
  public_id: string;
  eah_number: number | null;
  title: string | null;
  category: string;
  status: string;
  submitted_at: Date;
  reviewed_at: Date | null;
  reviewed_by_username: string | null;
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

  const { token: csrfToken, setCookie } = tokenForRequest(req);
  const canDelete = !!ctx.owner;

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
    `SELECT s.id, s.public_id, s.eah_number, s.title, s.category, s.status, s.submitted_at, s.reviewed_at,
            u.username AS reviewed_by_username
       FROM submissions s
       LEFT JOIN users u ON u.id = s.reviewed_by
       ${status ? "WHERE s.status = ?" : ""}
       ORDER BY s.submitted_at DESC
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

  // No bulk approve/reject here on purpose: every decision must carry a
  // reviewer message / rejection reason, which only the per-submission review
  // form (/admin/queue/:id) collects. So this page is read-only triage — click
  // through to "view →" to act on a row.
  const tableBody: SafeHtml = rows.length === 0
    ? h`<p><em>No submissions match.</em></p>`
    : h`
        <table class="all">
          <thead>
            <tr>
              <th>id</th>
              <th>eah id</th>
              <th>public id</th>
              <th>title</th>
              <th>category</th>
              <th>status</th>
              <th>submitted</th>
              <th>reviewed</th>
              <th>reviewed by</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => h`
              <tr>
                <td>${r.eah_number !== null
                  ? h`<a href="/admin/queue/${r.id}"><code>${formatEahId(r.eah_number)}</code></a>`
                  : h`<span class="muted">—</span>`}</td>
                <td><code>${r.public_id}</code></td>
                <td>${r.title ?? h`<em>(no title)</em>`}</td>
                <td>${categoryLabel(r.category)}</td>
                <td><span class="status-badge status-${r.status}">${r.status}</span></td>
                <td>${fmtDate(r.submitted_at)}</td>
                <td>${fmtDate(r.reviewed_at)}</td>
                <td>${r.reviewed_by_username ?? "—"}</td>
                <td>
                  <a href="/admin/queue/${r.id}">view →</a>${
                    canDelete && r.status === "published"
                      ? h` · <a class="del-link" href="/admin/all/${r.id}/delete">delete</a>`
                      : raw("")
                  }
                </td>
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

  const jumpToForm: SafeHtml = h`
    <form class="jump-to-form" method="get" action="/admin/entries/redirect">
      Jump to: <input type="text" name="id" placeholder="A000001" maxlength="10">
      <button type="submit">Go</button>
    </form>
  `;

  const body = h`
    ${jumpToForm}
    ${filterBar}
    ${tableBody}
    ${total > 0 ? pager : raw("")}
  `;

  const html = await layout({
    title: status ? `All submissions — ${status}` : "All submissions",
    heading: status ? `All submissions — ${status}` : "All submissions",
    body,
    user: ctx.user, csrfToken,
    bodyClass: "admin-wide",
  });
  return htmlResponse(html, { setCookie });
}

// ─── owner-only delete of a published entry ──────────────────────────────────
//
// Deleting is permanent and OWNER-only (the same trust level as deleting an
// account). It's two-step: GET renders a confirmation page, POST with confirm=1
// actually deletes. The submission's child rows (tags, messages, version diffs)
// cascade away via FK ON DELETE CASCADE.
//
// A-number policy: a deleted entry's number is RETIRED, not recycled — we do
// NOT push it into freed_eah_numbers. Interior numbers therefore leave a
// permanent gap. (Caveat: allocation is MAX(eah_number)+1, so deleting the
// single highest number lets the next new draft reclaim that integer; there's
// no high-water-mark table to prevent that edge case.)

function deleteAuthRedirect(): Response {
  return new Response(null, { status: 303, headers: { Location: "/admin/all" } });
}

async function deleteBadRequest(message: string, status = 400): Promise<Response> {
  const body = await layout({
    title: "Bad request",
    heading: "Bad request",
    body: h`<p>${message} <a href="/admin/all">Back to all submissions</a>.</p>`,
  });
  return htmlResponse(body, { status });
}

function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n > 0 ? n : null;
}

export async function getDeleteConfirm(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.owner) return deleteAuthRedirect();

  const id = parseId(ctx.params.id);
  if (id === null) return await deleteBadRequest("Invalid submission id.", 404);

  const row = await queryOne<{ id: number; eah_number: number | null; title: string | null; status: string }>(
    "SELECT id, eah_number, title, status FROM submissions WHERE id = ?",
    [id],
  );
  if (!row) return await deleteBadRequest("Submission not found.", 404);

  const { token: csrf, setCookie } = tokenForRequest(req);
  const label = row.eah_number !== null ? formatEahId(row.eah_number) : `id ${row.id}`;
  const body = h`
    <p>Delete <strong>${label}</strong> — “${row.title ?? "(no title)"}” [${row.status}]? This is
    permanent: the entry, its discussion, and its edit history are removed, and its A-number is
    retired (not reused).</p>
    <form method="post" action="/admin/all/${row.id}/delete">
      <input type="hidden" name="_csrf" value="${csrf}">
      <input type="hidden" name="confirm" value="1">
      <button type="submit" class="btn-danger">Delete entry</button>
    </form>
    <p><a href="/admin/all">Cancel</a></p>
  `;
  return htmlResponse(
    await layout({ title: "Delete entry · EAH admin", heading: "Delete entry", body, user: ctx.user, csrfToken: csrf }),
    { setCookie },
  );
}

export async function postDelete(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.owner) return await deleteBadRequest("Only owners can delete entries.", 403);

  const id = parseId(ctx.params.id);
  if (id === null) return await deleteBadRequest("Invalid submission id.", 404);

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 8 * 1024);
  } catch {
    return await deleteBadRequest("Form too large or malformed.", 413);
  }
  if (!verifyCsrf(req, form.get("_csrf"))) return await deleteBadRequest("Invalid CSRF token.", 403);
  if (form.get("confirm") !== "1") return deleteAuthRedirect();

  // Single statement: child rows cascade, the number is retired with the row.
  await execute("DELETE FROM submissions WHERE id = ?", [id]);
  return deleteAuthRedirect();
}
