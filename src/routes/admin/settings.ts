/**
 * Owner-only site settings.
 *
 *   GET  /admin/settings — show + edit owner-tunable settings
 *   POST /admin/settings — save them
 *
 * Currently just the reproduction vote threshold (see src/settings.ts). Only
 * owners (ctx.owner) may view or change these.
 */
import { h, raw, type SafeHtml } from "../../html.ts";
import { layout } from "../../layout.ts";
import { tokenForRequest, verifyCsrf } from "../../csrf.ts";
import {
  getReproThreshold, setReproThreshold,
  MIN_REPRO_THRESHOLD, MAX_REPRO_THRESHOLD, DEFAULT_REPRO_THRESHOLD,
} from "../../settings.ts";
import { htmlResponse, parseForm, type RouteContext } from "../types.ts";

function authRedirect(): Response {
  return new Response(null, { status: 303, headers: { Location: "/admin/login" } });
}

function renderPage(opts: {
  req: Request;
  ctx: RouteContext;
  error?: string | null;
  flash?: string | null;
  status?: number;
}): Response {
  const { req, ctx, error, flash } = opts;
  const { token: csrf, setCookie } = tokenForRequest(req);

  const errBlock: SafeHtml = error
    ? h`<div class="form-error" role="alert"><strong>Error:</strong> ${error}</div>`
    : raw("");
  const flashBlock: SafeHtml = flash ? h`<div class="flash-success">${flash}</div>` : raw("");

  const threshold = getReproThreshold();

  const body = h`
    ${flashBlock}
    <p><a href="/admin/queue">← back to queue</a></p>

    <h2>Reproduction approvals</h2>
    <p>How many distinct <strong>staff</strong> members must confirm a
       pending-acceptance entry before it is accepted (reproduced &amp; made
       active) or rejected (couldn't reproduce). The first side to reach this
       count wins. A single <strong>owner</strong> vote is always decisive and
       bypasses the count, and any one staff member can still move an entry from
       <em>pending review</em> to <em>pending acceptance</em> on their own — this
       threshold only governs the final accept/reject step.</p>
    ${errBlock}
    <form method="post" action="/admin/settings" class="submit-form">
      <input type="hidden" name="_csrf" value="${csrf}">
      <label for="repro_threshold">Required staff confirmations
        <small>(between ${String(MIN_REPRO_THRESHOLD)} and ${String(MAX_REPRO_THRESHOLD)};
        default ${String(DEFAULT_REPRO_THRESHOLD)})</small></label>
      <input id="repro_threshold" name="repro_threshold" type="number"
             min="${String(MIN_REPRO_THRESHOLD)}" max="${String(MAX_REPRO_THRESHOLD)}"
             value="${String(threshold)}" required>
      <div class="form-actions">
        <button type="submit">Save</button>
      </div>
    </form>
  `;

  return htmlResponse(
    layout({ title: "Settings · ENAIH admin", heading: "site settings", body, user: ctx.user, csrfToken: csrf, bodyClass: "admin-wide" }),
    { status: opts.status ?? 200, setCookie },
  );
}

export async function getSettings(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.owner) return authRedirect();
  const flash = ctx.url.searchParams.get("saved") === "1" ? "Settings saved." : null;
  return renderPage({ req, ctx, flash });
}

export async function postSettings(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.owner) return authRedirect();

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 8 * 1024);
  } catch {
    return renderPage({ req, ctx, error: "Form too large or malformed.", status: 413 });
  }
  if (!verifyCsrf(req, form.get("_csrf"))) {
    return renderPage({ req, ctx, error: "Invalid CSRF token. Reload and try again.", status: 403 });
  }

  const raw = (form.get("repro_threshold") ?? "").trim();
  if (!/^\d{1,3}$/.test(raw)) {
    return renderPage({ req, ctx, error: "Enter a whole number.", status: 400 });
  }
  const result = await setReproThreshold(parseInt(raw, 10));
  if (!result.ok) {
    return renderPage({ req, ctx, error: result.error, status: 400 });
  }
  return new Response(null, { status: 303, headers: { Location: "/admin/settings?saved=1" } });
}
