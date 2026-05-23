/**
 * Account signup.
 *
 *   GET  /signup  — render form. Hides the email/password form when the
 *                   Resend monthly cap is hit so we never start a flow we
 *                   can't complete.
 *   POST /signup  — validate inputs, then issue a pending-verify cookie and
 *                   redirect to /verify regardless of whether the email is
 *                   already taken. ENUMERATION-RESISTANT — see below.
 *
 * Enumeration resistance:
 *   The response to /signup MUST look the same whether the submitted email
 *   is in use or not. Concretely:
 *     - Same HTTP status (303)
 *     - Same Location header (/verify)
 *     - Same Set-Cookie (pending-verify, scoped to /verify)
 *     - Same response body (none)
 *   The pending-verify cookie carries a user_id signed with SESSION_SECRET
 *   so the attacker can't tell which user it points at. On /verify, codes
 *   for a non-existent or already-verified target deterministically fail
 *   with the same "wrong code" message as a real-but-wrong attempt.
 *
 *   Username collision is NOT hidden — it's a forms-validation concern and
 *   usernames are public anyway (they'll appear next to published entries).
 */
import { h, raw, type SafeHtml } from "../html.ts";
import { layout } from "../layout.ts";
import { queryOne, transaction } from "../db.ts";
import {
  hashPassword,
  issueVerificationCode,
  encodePendingVerifyCookie,
} from "../auth.ts";
import { tokenForRequest, verifyCsrf } from "../csrf.ts";
import { check as rateLimitCheck } from "../ratelimit.ts";
import { googleOAuthEnabled } from "../oauth-google.ts";
import { config } from "../config.ts";
import { emailCapReached, sendVerificationCode } from "../email.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteContext } from "./types.ts";

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 10;
const MAX_PASSWORD_LEN = 200;

interface FormValues {
  username: string;
  email: string;
}

function csrfErrorResponse(): Response {
  return htmlResponse(
    layout({
      title: "Invalid CSRF token",
      heading: "Invalid CSRF token",
      body: h`<p>Your form submission could not be verified. Please go back and try again.</p>`,
    }),
    { status: 403 },
  );
}

function googleButton(csrfToken: string): SafeHtml {
  if (!googleOAuthEnabled()) return raw("");
  return h`
    <div class="oauth-shell">
      <div id="g_id_onload" data-client_id="${config.googleOAuth.clientId}" data-auto_prompt="false" data-callback="handleGisCredential" data-csrf="${csrfToken}"></div>
      <div class="oauth-button-wrap">
        <div class="g_id_signin" data-type="standard" data-size="large" data-theme="outline" data-text="signin_with" data-shape="rectangular" data-logo_alignment="left"></div>
      </div>
    </div>
  `;
}

function renderSignupPage(opts: {
  csrfToken: string;
  csrfSetCookie: string | null;
  capReached: boolean;
  values?: FormValues;
  error?: string;
  status?: number;
}): Response {
  const error: SafeHtml = opts.error
    ? h`<p class="error" role="alert">${opts.error}</p>`
    : raw("");

  if (opts.capReached && !googleOAuthEnabled()) {
    const body = h`
      <p>Sorry — we've hit our monthly email send limit and can't deliver
      verification codes right now. Try again next month, or check back
      after we've upgraded our email plan.</p>
      <p><a href="/">Home</a> · <a href="/login">Sign in</a></p>
    `;
    return htmlResponse(
      layout({ title: "Signup paused · EAH", heading: "Signup paused", body }),
      { status: 503, setCookie: opts.csrfSetCookie },
    );
  }

  const passwordForm: SafeHtml = opts.capReached
    ? h`
      <p class="muted">
        Email signup is temporarily paused — we've hit our monthly email
        send limit. Use "Continue with Google" above instead.
      </p>
    `
    : h`
      <form method="post" action="/signup" autocomplete="on">
        <input type="hidden" name="_csrf" value="${opts.csrfToken}">
        ${error}
        <p>
          <label for="username">Username</label><br>
          <small class="muted">3–40 chars, letters / digits / _ . -</small><br>
          <input type="text" id="username" name="username"
                 value="${opts.values?.username ?? ""}"
                 minlength="3" maxlength="40" required autofocus
                 autocomplete="username">
        </p>
        <p>
          <label for="email">Email</label><br>
          <small class="muted">Required. We send a 6-digit verification code to confirm it's yours.</small><br>
          <input type="email" id="email" name="email"
                 value="${opts.values?.email ?? ""}"
                 maxlength="254" required autocomplete="email">
        </p>
        <p>
          <label for="password">Password</label><br>
          <small class="muted">At least ${String(MIN_PASSWORD_LEN)} characters. No other rules — pick something you can remember.</small><br>
          <input type="password" id="password" name="password"
                 minlength="${String(MIN_PASSWORD_LEN)}" maxlength="${String(MAX_PASSWORD_LEN)}" required
                 autocomplete="new-password">
        </p>
        <p>
          <button type="submit">Create account</button>
        </p>
      </form>
    `;

  const dividerWord: SafeHtml = (googleOAuthEnabled() && !opts.capReached)
    ? h`<p class="muted oauth-divider">or sign up with email and password</p>`
    : raw("");

  const body = h`
    ${googleButton(opts.csrfToken)}
    ${dividerWord}
    ${passwordForm}
    <p>Already have an account? <a href="/login">Sign in</a>.</p>
  `;
  return htmlResponse(
    layout({ title: "Sign up · EAH", heading: "Create an account", body }),
    { status: opts.status ?? 200, setCookie: opts.csrfSetCookie },
  );
}

export async function getSignup(req: Request, ctx: RouteContext): Promise<Response> {
  if (ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/" } });
  }
  const { token, setCookie } = tokenForRequest(req);
  return renderSignupPage({
    csrfToken: token,
    csrfSetCookie: setCookie,
    capReached: emailCapReached(),
  });
}

export async function postSignup(req: Request, ctx: RouteContext): Promise<Response> {
  const rl = rateLimitCheck("signup", ctx.ip);
  if (!rl.allowed) {
    const body = layout({
      title: "Too many attempts",
      heading: "Slow down",
      body: h`<p>Please wait ${String(rl.retryAfterSec ?? 60)} seconds before trying again.</p>`,
    });
    const headers: Record<string, string> = {};
    if (rl.retryAfterSec) headers["Retry-After"] = String(rl.retryAfterSec);
    return htmlResponse(body, { status: 429, headers });
  }

  if (emailCapReached()) {
    const { token, setCookie } = tokenForRequest(req);
    return renderSignupPage({
      csrfToken: token,
      csrfSetCookie: setCookie,
      capReached: true,
      error: "email signup is temporarily paused",
      status: 503,
    });
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

  const username = sanitizeText((form.get("username") ?? "").trim());
  const emailRaw = sanitizeText((form.get("email") ?? "").trim()).toLowerCase();
  const password = form.get("password") ?? "";

  // Shape validation only — these would short-circuit any signup whether the
  // email is taken or not, so leaking them via different status codes is
  // fine. The username-taken case is handled below.
  const errors: string[] = [];
  if (!USERNAME_RE.test(username)) {
    errors.push("Username must be 3–40 chars: letters, digits, underscore, dot, or hyphen.");
  }
  if (emailRaw.length === 0 || emailRaw.length > 254 || !EMAIL_RE.test(emailRaw)) {
    errors.push("Please enter a valid email address.");
  }
  if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
    errors.push(`Password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} characters.`);
  }
  if (errors.length > 0) {
    const { token, setCookie } = tokenForRequest(req);
    return renderSignupPage({
      csrfToken: token,
      csrfSetCookie: setCookie,
      capReached: false,
      values: { username, email: emailRaw },
      error: errors.join(" "),
      status: 400,
    });
  }

  // Username availability check. Leaking this is fine: usernames are public,
  // and the user needs to know if they need to pick another one.
  const usernameTaken = await queryOne<{ id: number }>(
    "SELECT id FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1",
    [username],
  );
  if (usernameTaken) {
    const { token, setCookie } = tokenForRequest(req);
    return renderSignupPage({
      csrfToken: token,
      csrfSetCookie: setCookie,
      capReached: false,
      values: { username, email: emailRaw },
      error: "That username is already taken.",
      status: 409,
    });
  }

  // Hash the password BEFORE we know if we'll need it, so the work happens
  // on every signup attempt regardless of whether the email is taken. This
  // is more important than the conditional approach because it equalizes
  // timing between "new email" and "existing email" paths.
  const passwordHash = await hashPassword(password);

  // The key enumeration-resistant branch. Everything below converges on the
  // same response: 303 to /verify with a pending-verify cookie.
  //
  // Either-or:
  //   (a) Email already in use → don't touch the existing user; cookie
  //       points at their id, /verify always fails because attacker doesn't
  //       have the code from their inbox.
  //   (b) Email is new → insert the user inside a tx (so a UNIQUE race
  //       resolves cleanly), then outside the tx issue + email a code.
  const branch = await transaction(async (tx) => {
    const existing = await tx.queryOne<{ id: number }>(
      "SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
      [emailRaw],
    );
    if (existing) return { kind: "existing" as const, userId: existing.id };
    try {
      const ins = await tx.execute(
        `INSERT INTO users (username, email, email_verified, password_hash, is_admin)
         VALUES (?, ?, 0, ?, 0)`,
        [username, emailRaw, passwordHash],
      );
      return { kind: "new" as const, userId: ins.insertId };
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) {
        // Concurrent insert beat us. Resolve to whoever's row now lives at
        // this email and behave as if it was case (a).
        const u = await tx.queryOne<{ id: number }>(
          "SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
          [emailRaw],
        );
        if (u) return { kind: "existing" as const, userId: u.id };
      }
      throw err;
    }
  });

  if (branch.kind === "new") {
    const code = await issueVerificationCode(branch.userId);
    void sendVerificationCode({ to: emailRaw, code, username });
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: "/verify",
      "Set-Cookie": encodePendingVerifyCookie(branch.userId),
    },
  });
}
