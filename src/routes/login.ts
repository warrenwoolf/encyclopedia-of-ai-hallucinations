/**
 * Login routes.
 *
 *   GET  /login   — render form (password + optional Google button)
 *   POST /login   — verify creds, create session, redirect
 *   POST /logout  — destroy session, clear cookie, redirect to /
 *
 * Identifier can be either username OR email. Both are unique on the users
 * table so a single lookup with an OR is fine.
 */
import { h, raw, type SafeHtml } from "../html.ts";
import { layout } from "../layout.ts";
import { queryOne } from "../db.ts";
import {
  verifyPassword,
  createSession,
  destroySession,
  clearSessionCookie,
  encodePendingVerifyCookie,
} from "../auth.ts";
import { tokenForRequest, verifyCsrf } from "../csrf.ts";
import { check as rateLimitCheck } from "../ratelimit.ts";
import { googleOAuthEnabled } from "../oauth-google.ts";
import { htmlResponse, parseForm, type RouteContext } from "./types.ts";

function csrfErrorResponse(): Response {
  const body = layout({
    title: "Invalid CSRF token",
    heading: "Invalid CSRF token",
    body: h`<p>Your form submission could not be verified. Please go back and try again.</p>`,
  });
  return htmlResponse(body, { status: 403 });
}

function googleButton(csrfToken: string): SafeHtml {
  if (!googleOAuthEnabled()) return raw("");
  return h`
    <form method="post" action="/oauth/google/start" class="oauth-form">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <button type="submit" class="oauth-button">Continue with Google</button>
    </form>
    <p class="muted oauth-divider">or sign in with username/email and password</p>
  `;
}

function renderLoginPage(opts: {
  csrfToken: string;
  csrfSetCookie: string | null;
  identifier?: string;
  error?: string;
  status?: number;
  user?: any;
}): Response {
  const error: SafeHtml = opts.error
    ? h`<p class="error" role="alert">${opts.error}</p>`
    : raw("");
  const body = h`
    ${googleButton(opts.csrfToken)}
    <form method="post" action="/login" autocomplete="on">
      <input type="hidden" name="_csrf" value="${opts.csrfToken}">
      ${error}
      <p>
        <label for="identifier">Username or email</label><br>
        <input type="text" id="identifier" name="identifier" value="${opts.identifier ?? ""}" required autofocus autocomplete="username">
      </p>
      <p>
        <label for="password">Password</label><br>
        <input type="password" id="password" name="password" required autocomplete="current-password">
      </p>
      <p>
        <button type="submit">Sign in</button>
      </p>
    </form>
    <p>Don't have an account yet? <a href="/signup">Sign up</a>.</p>
  `;
  return htmlResponse(
    layout({ title: "Sign in · EAH", heading: "Sign in", body, user: opts.user ?? null }),
    {
      status: opts.status ?? 200,
      setCookie: opts.csrfSetCookie,
    },
  );
}

export async function getLogin(req: Request, ctx: RouteContext): Promise<Response> {
  if (ctx.user) {
    // Already signed in — bounce home (or to /admin/queue if admin).
    const next = ctx.user.isAdmin ? "/admin/queue" : "/";
    return new Response(null, { status: 303, headers: { Location: next } });
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
    return htmlResponse(
      layout({
        title: "Bad request",
        heading: "Bad request",
        body: h`<p>The form submission was too large or malformed.</p>`,
      }),
      { status: 400 },
    );
  }

  if (!verifyCsrf(req, form.get("_csrf"))) return csrfErrorResponse();

  const identifier = (form.get("identifier") ?? "").trim();
  const password = form.get("password") ?? "";

  // Length caps keep argon2 from being abused as a CPU sink. 80 chars
  // covers any sane username; 254 covers RFC 5321 email lengths; 200 cap on
  // password is well above any reasonable user passphrase.
  if (
    identifier.length === 0 || identifier.length > 254 ||
    password.length === 0 || password.length > 200
  ) {
    const { token, setCookie } = tokenForRequest(req);
    return renderLoginPage({
      csrfToken: token,
      csrfSetCookie: setCookie,
      identifier: identifier.slice(0, 254),
      error: "invalid credentials",
      status: 401,
    });
  }

  // Case-folding: emails are case-insensitive in practice; the table's
  // collation is *_unicode_ci so MariaDB matches case-insensitively anyway,
  // but we normalize to lowercase for the lookup so future case-sensitive
  // collations don't break us.
  const lookup = identifier.toLowerCase();

  const user = await queryOne<{
    id: number;
    password_hash: string | null;
    email_verified: number;
  }>(
    "SELECT id, password_hash, email_verified FROM users WHERE LOWER(username) = ? OR LOWER(email) = ? LIMIT 1",
    [lookup, lookup],
  );

  // Constant-time-ish: always run a verify against SOMETHING so the response
  // time doesn't reveal whether the user exists.
  const dummyHash = "$argon2id$v=19$m=65536,t=3,p=4$YWFhYWFhYWFhYWFhYWFhYQ$ZsZ06rIWlMnksB13W/cZdBwlhrYdH3CdwiKKBmw8VyU";
  let ok = false;
  if (user && user.password_hash) {
    ok = await verifyPassword(password, user.password_hash);
  } else {
    await verifyPassword(password, dummyHash);
  }

  if (!ok || !user) {
    const { token, setCookie } = tokenForRequest(req);
    return renderLoginPage({
      csrfToken: token,
      csrfSetCookie: setCookie,
      identifier,
      error: "invalid credentials",
      status: 401,
    });
  }

  // Unverified accounts don't get a session — sessions imply "fully signed
  // in", and an unverified account can't act on submissions etc. Instead we
  // hand them a pending-verify cookie and send them through the /verify
  // flow, exactly like signup. On successful verify they get a real session.
  if (user.email_verified === 0) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/verify",
        "Set-Cookie": encodePendingVerifyCookie(user.id),
      },
    });
  }

  const { cookie } = await createSession(user.id);
  return new Response(null, {
    status: 303,
    headers: { Location: "/", "Set-Cookie": cookie },
  });
}

export async function postLogout(req: Request, ctx: RouteContext): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = await parseForm(req);
  } catch {
    return htmlResponse(
      layout({
        title: "Bad request",
        heading: "Bad request",
        body: h`<p>The form submission was too large or malformed.</p>`,
      }),
      { status: 400 },
    );
  }
  if (!verifyCsrf(req, form.get("_csrf"))) return csrfErrorResponse();

  if (ctx.user) {
    try {
      await destroySession(ctx.user.token);
    } catch {
      // best-effort; session may already be gone
    }
  }
  return new Response(null, {
    status: 303,
    headers: { Location: "/", "Set-Cookie": clearSessionCookie() },
  });
}
