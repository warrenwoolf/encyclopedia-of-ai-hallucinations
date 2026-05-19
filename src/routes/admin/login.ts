/**
 * Admin login / logout handlers.
 *
 *   GET  /admin/login   — render the login form
 *   POST /admin/login   — verify creds, create session
 *   POST /admin/logout  — destroy session, clear cookie
 */
import { h, raw, type SafeHtml } from "../../html.ts";
import { layout } from "../../layout.ts";
import { queryOne } from "../../db.ts";
import {
  verifyPassword,
  createSession,
  destroySession,
  clearSessionCookie,
} from "../../auth.ts";
import { tokenForRequest, verifyCsrf } from "../../csrf.ts";
import { check as rateLimitCheck } from "../../ratelimit.ts";
import { htmlResponse, parseForm, type RouteContext } from "../types.ts";

function csrfErrorResponse(): Response {
  const body = layout({
    title: "Invalid CSRF token",
    heading: "Invalid CSRF token",
    body: h`<p>Your form submission could not be verified. Please go back and try again.</p>`,
  });
  return htmlResponse(body, { status: 403 });
}

function renderLoginPage(opts: {
  csrfToken: string;
  csrfSetCookie: string | null;
  username?: string;
  error?: string;
  status?: number;
  extraHeaders?: Record<string, string>;
}): Response {
  const error: SafeHtml = opts.error
    ? h`<p class="error" role="alert">${opts.error}</p>`
    : raw("");
  const body = h`
    <form method="post" action="/admin/login" autocomplete="off">
      <input type="hidden" name="_csrf" value="${opts.csrfToken}">
      ${error}
      <p>
        <label for="username">Username</label><br>
        <input type="text" id="username" name="username" value="${opts.username ?? ""}" required autofocus>
      </p>
      <p>
        <label for="password">Password</label><br>
        <input type="password" id="password" name="password" required>
      </p>
      <p>
        <button type="submit">Sign in</button>
      </p>
    </form>
  `;
  const html = layout({
    title: "Admin login",
    heading: "Admin login",
    body,
  });
  return htmlResponse(html, {
    status: opts.status ?? 200,
    setCookie: opts.csrfSetCookie,
    headers: opts.extraHeaders,
  });
}

export async function getLogin(req: Request, ctx: RouteContext): Promise<Response> {
  if (ctx.admin) {
    return new Response(null, { status: 303, headers: { Location: "/admin/queue" } });
  }
  const { token, setCookie } = tokenForRequest(req);
  return renderLoginPage({ csrfToken: token, csrfSetCookie: setCookie });
}

export async function postLogin(req: Request, ctx: RouteContext): Promise<Response> {
  const rl = rateLimitCheck("login", ctx.ip);
  if (!rl.allowed) {
    const body = layout({
      title: "Too many attempts",
      heading: "Too many login attempts",
      body: h`<p>Please wait ${String(rl.retryAfterSec ?? 60)} seconds before trying again.</p>`,
    });
    const headers: Record<string, string> = {};
    if (rl.retryAfterSec) headers["Retry-After"] = String(rl.retryAfterSec);
    return htmlResponse(body, { status: 429, headers });
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req);
  } catch {
    const body = layout({
      title: "Bad request",
      heading: "Bad request",
      body: h`<p>The form submission was too large or malformed.</p>`,
    });
    return htmlResponse(body, { status: 400 });
  }

  const csrf = form.get("_csrf");
  if (!verifyCsrf(req, csrf)) return csrfErrorResponse();

  const username = (form.get("username") ?? "").trim();
  const password = form.get("password") ?? "";

  // Hard length caps to keep bcrypt from being abused as a CPU sink.
  if (username.length === 0 || username.length > 80 || password.length === 0 || password.length > 200) {
    const { token, setCookie } = tokenForRequest(req);
    return renderLoginPage({
      csrfToken: token,
      csrfSetCookie: setCookie,
      username: username.slice(0, 80),
      error: "invalid credentials",
      status: 401,
    });
  }

  const admin = await queryOne<{ id: number; password_hash: string }>(
    "SELECT id, password_hash FROM admins WHERE username = ?",
    [username],
  );

  let ok = false;
  if (admin) {
    ok = await verifyPassword(password, admin.password_hash);
  } else {
    // Constant-time-ish: still hash *something* to avoid timing oracle on username existence.
    // bcrypt.compare against a known-bad hash returns false in similar time.
    await verifyPassword(password, "$2a$12$abcdefghijklmnopqrstuvCY7xJX0Va.RIyc1S.0bM1G9PuQ4WNB6S");
  }

  if (!ok || !admin) {
    const { token, setCookie } = tokenForRequest(req);
    return renderLoginPage({
      csrfToken: token,
      csrfSetCookie: setCookie,
      username,
      error: "invalid credentials",
      status: 401,
    });
  }

  const { cookie } = await createSession(admin.id);
  return new Response(null, {
    status: 303,
    headers: { Location: "/admin/queue", "Set-Cookie": cookie },
  });
}

export async function postLogout(req: Request, ctx: RouteContext): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = await parseForm(req);
  } catch {
    const body = layout({
      title: "Bad request",
      heading: "Bad request",
      body: h`<p>The form submission was too large or malformed.</p>`,
    });
    return htmlResponse(body, { status: 400 });
  }
  if (!verifyCsrf(req, form.get("_csrf"))) return csrfErrorResponse();

  if (ctx.admin) {
    try {
      await destroySession(ctx.admin.token);
    } catch {
      // best effort; session may already be gone
    }
  }

  return new Response(null, {
    status: 303,
    headers: { Location: "/", "Set-Cookie": clearSessionCookie() },
  });
}
