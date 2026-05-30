/**
 * Staff-managed category list.
 *
 *   GET  /admin/categories  — list existing categories + a form to add one
 *   POST /admin/categories  — add a new category, then refresh the cache
 *
 * Categories are stored in the `categories` table and cached in src/categories.ts.
 * Staff (is_admin) may add new ones; they show up immediately in the submit,
 * edit, review, and browse category controls. Deletion isn't offered — removing
 * a category would orphan the `submissions.category` values that reference it.
 */
import { h, raw, type SafeHtml } from "../../html.ts";
import { layout } from "../../layout.ts";
import { tokenForRequest, verifyCsrf } from "../../csrf.ts";
import { CATEGORIES, addCategory, slugifyCategoryKey } from "../../categories.ts";
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
}): Response {
  const { csrf, error, flash, values } = opts;

  const errBlock: SafeHtml = error
    ? h`<div class="form-error" role="alert"><strong>Error:</strong> ${error}</div>`
    : raw("");
  const flashBlock: SafeHtml = flash ? h`<div class="flash-success">${flash}</div>` : raw("");

  const list: SafeHtml = h`
    <table class="all">
      <thead>
        <tr><th>key</th><th>label</th><th>description</th></tr>
      </thead>
      <tbody>
        ${CATEGORIES.map((c) => h`
          <tr>
            <td><code>${c.key}</code></td>
            <td>${c.label}</td>
            <td>${c.description}</td>
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
  const flash = ctx.url.searchParams.get("added") === "1" ? "Category added." : null;
  return renderPage({ csrf: token, setCookie, flash, user: ctx.user });
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
