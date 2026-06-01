/**
 * Staff-managed category list.
 *
 *   GET  /admin/categories              — list existing categories + a form to add one
 *   POST /admin/categories              — add a new category, then refresh the cache
 *   GET  /admin/categories/:key/delete  — owner-only confirm page (pick reassign target)
 *   POST /admin/categories/:key/delete  — owner-only delete + reassign in one transaction
 *
 * Categories are stored in the `categories` table and cached in src/categories.ts.
 * Staff (is_admin) may add new ones; owners may also delete them. The confirm page
 * requires choosing a reassign target so no submissions are silently orphaned.
 */
import { h, raw, type SafeHtml } from "../../html.ts";
import { layout } from "../../layout.ts";
import { tokenForRequest, verifyCsrf } from "../../csrf.ts";
import { CATEGORIES, addCategory, deleteCategory, slugifyCategoryKey } from "../../categories.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteContext } from "../types.ts";
import type { UserSession } from "../../auth.ts";

function authRedirect(): Response {
  return new Response(null, { status: 303, headers: { Location: "/admin/login" } });
}

function renderPage(opts: {
  csrf: string;
  setCookie?: string | null;
  error?: string | null;
  flash?: string | null;
  values?: { label: string; key: string; description: string };
  status?: number;
  user?: UserSession | null;
  isOwner?: boolean;
}): Response {
  const { csrf, error, flash, values } = opts;

  const errBlock: SafeHtml = error
    ? h`<div class="form-error" role="alert"><strong>Error:</strong> ${error}</div>`
    : raw("");
  const flashBlock: SafeHtml = flash ? h`<div class="flash-success">${flash}</div>` : raw("");

  const list: SafeHtml = h`
    <table class="all">
      <thead>
        <tr><th>key</th><th>label</th><th>description</th>${opts.isOwner ? h`<th></th>` : raw("")}</tr>
      </thead>
      <tbody>
        ${CATEGORIES.map((c) => h`
          <tr>
            <td><code>${c.key}</code></td>
            <td>${c.label}</td>
            <td>${c.description}</td>
            ${opts.isOwner
              ? h`<td><a class="del-link" href="/admin/categories/${c.key}/delete">delete</a></td>`
              : raw("")}
          </tr>
        `)}
      </tbody>
    </table>
  `;

  const body = h`
    ${flashBlock}
    <p><a href="/admin/queue">← back to queue</a></p>
    <h2>existing categories (${String(CATEGORIES.length)})</h2>
    ${list}

    <h2>add a category</h2>
    ${errBlock}
    <form method="post" action="/admin/categories" class="submit-form">
      <input type="hidden" name="_csrf" value="${csrf}">

      <label for="label">Label <small>(shown to users, e.g. "Math / Arithmetic")</small></label>
      <input id="label" name="label" type="text" maxlength="120" required
             value="${values?.label ?? ""}">

      <label for="key">Key <small>(optional — lowercase slug; auto-derived from the label if left blank)</small></label>
      <input id="key" name="key" type="text" maxlength="40"
             value="${values?.key ?? ""}" placeholder="e.g. math-arithmetic">

      <label for="description">Description <small>(shown in browse / on hover)</small></label>
      <textarea id="description" name="description" rows="3" maxlength="1000">${values?.description ?? ""}</textarea>

      <div class="form-actions">
        <button type="submit">Add category</button>
      </div>
    </form>
  `;

  return htmlResponse(
    layout({ title: "Categories · ENAIH admin", heading: "categories", body, user: opts.user, csrfToken: csrf, bodyClass: "admin-wide" }),
    { status: opts.status ?? 200, setCookie: opts.setCookie },
  );
}

export async function getCategories(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();
  const { token, setCookie } = tokenForRequest(req);
  const added = ctx.url.searchParams.get("added") === "1";
  const deleted = ctx.url.searchParams.get("deleted");
  const flash = added ? "Category added." : deleted ? `Category "${deleted}" deleted.` : null;
  return renderPage({ csrf: token, setCookie, flash, user: ctx.user, isOwner: !!ctx.owner });
}

export async function postCategory(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 16 * 1024);
  } catch {
    const { token, setCookie } = tokenForRequest(req);
    return renderPage({ csrf: token, setCookie, error: "Form too large or malformed.", status: 413, user: ctx.user });
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    const { token, setCookie } = tokenForRequest(req);
    return renderPage({ csrf: token, setCookie, error: "Invalid CSRF token. Reload and try again.", status: 403, user: ctx.user });
  }

  const label = sanitizeText(form.get("label") ?? "").trim();
  const keyRaw = sanitizeText(form.get("key") ?? "").trim();
  const description = sanitizeText(form.get("description") ?? "").trim();
  const key = keyRaw.length > 0 ? keyRaw : slugifyCategoryKey(label);

  const result = await addCategory(label, description, key);
  if (!result.ok) {
    const { token, setCookie } = tokenForRequest(req);
    return renderPage({
      csrf: token,
      setCookie,
      error: result.error,
      values: { label, key: keyRaw, description },
      status: 400,
      user: ctx.user,
    });
  }

  return new Response(null, { status: 303, headers: { Location: "/admin/categories?added=1" } });
}

// ─── owner-only category deletion ────────────────────────────────────────────

export async function getDeleteCategory(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.owner) return authRedirect();

  const key = ctx.params.key ?? "";
  const cat = CATEGORIES.find((c) => c.key === key);
  if (!cat) {
    return new Response(null, { status: 303, headers: { Location: "/admin/categories" } });
  }

  const { token: csrf, setCookie } = tokenForRequest(req);
  const others = CATEGORIES.filter((c) => c.key !== key);

  const body = h`
    <p><a href="/admin/categories">← back to categories</a></p>
    <p>Delete category <strong>${cat.label}</strong> (<code>${cat.key}</code>)? This is permanent.</p>
    <p>All submissions currently in this category must be reassigned or left uncategorized.</p>
    <form method="post" action="/admin/categories/${cat.key}/delete" class="submit-form">
      <input type="hidden" name="_csrf" value="${csrf}">
      <input type="hidden" name="confirm" value="1">
      <label for="reassign">Reassign submissions to</label>
      <select id="reassign" name="reassign">
        <option value="">(uncategorized)</option>
        ${others.map((c) => h`<option value="${c.key}">${c.label}</option>`)}
      </select>
      <div class="form-actions">
        <button type="submit" class="btn-danger">Delete category</button>
      </div>
    </form>
  `;

  return htmlResponse(
    await layout({ title: "Delete category · ENAIH admin", heading: "delete category", body, user: ctx.user, csrfToken: csrf }),
    { setCookie },
  );
}

export async function postDeleteCategory(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.owner) return authRedirect();

  const key = ctx.params.key ?? "";

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 8 * 1024);
  } catch {
    return new Response(null, { status: 303, headers: { Location: "/admin/categories" } });
  }
  if (!verifyCsrf(req, form.get("_csrf"))) {
    return new Response(null, { status: 303, headers: { Location: "/admin/categories" } });
  }
  if (form.get("confirm") !== "1") {
    return new Response(null, { status: 303, headers: { Location: "/admin/categories" } });
  }

  const reassignTo = form.get("reassign") ?? "";
  const result = await deleteCategory(key, reassignTo);
  if (!result.ok) {
    const { token, setCookie } = tokenForRequest(req);
    return renderPage({ csrf: token, setCookie, error: result.error, user: ctx.user, isOwner: true, status: 400 });
  }

  return new Response(null, { status: 303, headers: { Location: `/admin/categories?deleted=${encodeURIComponent(key)}` } });
}
