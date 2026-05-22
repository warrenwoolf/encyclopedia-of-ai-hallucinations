/**
 * Email-verification routes (6-digit code).
 *
 *   GET  /verify         — render the code-entry form
 *   POST /verify         — check the code; on success create the session
 *   POST /verify/resend  — issue + email a fresh code
 *
 * Authentication here comes from the `eah_pending_verify` cookie set by
 * /signup or /login, NOT from a session — unverified accounts intentionally
 * have no session. The cookie is HMAC-signed and only carries a user_id.
 *
 * Enumeration resistance: a cookie pointing at a verified or non-existent
 * user yields the same "wrong code" response as a real-but-wrong attempt.
 * This is how the /signup path gets to keep its "we always redirect to
 * /verify" shape — the attacker can't tell from /verify's response whether
 * the email was new or already taken.
 */
import { h, raw, type SafeHtml } from "../html.ts";
import { layout } from "../layout.ts";
import { queryOne } from "../db.ts";
import {
  consumeVerificationCode,
  issueVerificationCode,
  decodePendingVerifyCookie,
  clearPendingVerifyCookie,
  createSession,
} from "../auth.ts";
import { tokenForRequest, verifyCsrf } from "../csrf.ts";
import { check as rateLimitCheck } from "../ratelimit.ts";
import { emailCapReached, sendVerificationCode } from "../email.ts";
import { htmlResponse, parseForm, type RouteContext } from "./types.ts";

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

/** Fetch the email associated with the pending cookie's user_id, or null. */
async function pendingEmail(userId: number): Promise<string | null> {
  const row = await queryOne<{ email: string; email_verified: number }>(
    "SELECT email, email_verified FROM users WHERE id = ?",
    [userId],
  );
  if (!row) return null;
  return row.email;
}

function noPendingResponse(): Response {
  // No usable cookie — the user got here directly or the cookie expired.
  // Send them somewhere reasonable.
  const body = h`<p>This page is for finishing a signup. Start one at
    <a href="/signup">sign up</a>, or <a href="/login">sign in</a> if you
    already have an account.</p>`;
  return htmlResponse(
    layout({ title: "Verify email · EAH", heading: "Verify your email", body }),
    { status: 400 },
  );
}

function renderVerifyPage(opts: {
  csrfToken: string;
  csrfSetCookie: string | null;
  email: string;
  error?: string;
  notice?: string;
  status?: number;
}): Response {
  const error: SafeHtml = opts.error
    ? h`<p class="error" role="alert">${opts.error}</p>`
    : raw("");
  const notice: SafeHtml = opts.notice
    ? h`<p class="notice">${opts.notice}</p>`
    : raw("");
  const body = h`
    <p>If we know that address, we sent a 6-digit code to <strong>${opts.email}</strong>.
       Enter it below to finish creating your account.</p>
    ${notice}
    ${error}
    <form method="post" action="/verify" autocomplete="off">
      <input type="hidden" name="_csrf" value="${opts.csrfToken}">
      <p>
        <label for="code">Verification code</label><br>
        <input type="text" id="code" name="code"
               inputmode="numeric" pattern="\\d{6}" minlength="6" maxlength="6"
               autocomplete="one-time-code" required autofocus>
      </p>
      <p>
        <button type="submit">Verify</button>
      </p>
    </form>
    <form method="post" action="/verify/resend" class="inline-form">
      <input type="hidden" name="_csrf" value="${opts.csrfToken}">
      <button type="submit" class="linkbutton">Send a new code</button>
    </form>
  `;
  return htmlResponse(
    layout({ title: "Verify email · EAH", heading: "Verify your email", body }),
    { status: opts.status ?? 200, setCookie: opts.csrfSetCookie },
  );
}

export async function getVerify(req: Request, ctx: RouteContext): Promise<Response> {
  if (ctx.user) {
    // Already signed in.
    return new Response(null, { status: 303, headers: { Location: "/" } });
  }
  const pending = decodePendingVerifyCookie(req);
  if (!pending) return noPendingResponse();
  const email = await pendingEmail(pending.userId);
  if (!email) return noPendingResponse();

  const { token, setCookie } = tokenForRequest(req);
  return renderVerifyPage({
    csrfToken: token,
    csrfSetCookie: setCookie,
    email,
  });
}

export async function postVerify(req: Request, ctx: RouteContext): Promise<Response> {
  if (ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/" } });
  }

  const rl = rateLimitCheck("verify", ctx.ip);
  if (!rl.allowed) {
    const headers: Record<string, string> = {};
    if (rl.retryAfterSec) headers["Retry-After"] = String(rl.retryAfterSec);
    return htmlResponse(
      layout({
        title: "Too many attempts",
        heading: "Slow down",
        body: h`<p>Please wait ${String(rl.retryAfterSec ?? 60)} seconds before trying again.</p>`,
      }),
      { status: 429, headers },
    );
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

  const pending = decodePendingVerifyCookie(req);
  if (!pending) return noPendingResponse();
  const email = await pendingEmail(pending.userId);
  if (!email) return noPendingResponse();

  const code = (form.get("code") ?? "").trim();
  const result = await consumeVerificationCode(pending.userId, code);

  if (result.ok) {
    // Promote to a real session. Clear the pending cookie.
    const { cookie: sessionCookie } = await createSession(pending.userId);
    const headers = new Headers({ Location: "/" });
    headers.append("Set-Cookie", sessionCookie);
    headers.append("Set-Cookie", clearPendingVerifyCookie());
    return new Response(null, { status: 303, headers });
  }

  // All non-ok reasons render the same surface message ("that code didn't
  // match"). Internally we may distinguish "expired" / "exhausted" to
  // explain the path forward — but the differences don't leak whether the
  // email was actually in use, because both target paths (existing-verified
  // and existing-unverified-with-wrong-attempt) end up in the same state
  // here.
  const messages: Record<string, string> = {
    expired: "That code has expired. Send a new one and try again.",
    exhausted: "Too many wrong tries. Send a new code and try again.",
    mismatch: "That code didn't match. Try again.",
    none: "That code didn't match. Try again.", // intentionally same as mismatch
  };
  const reason = result.reason ?? "mismatch";
  const { token, setCookie } = tokenForRequest(req);
  return renderVerifyPage({
    csrfToken: token,
    csrfSetCookie: setCookie,
    email,
    error: messages[reason] ?? "Verification failed.",
    status: 400,
  });
}

export async function postVerifyResend(req: Request, ctx: RouteContext): Promise<Response> {
  if (ctx.user) {
    return new Response(null, { status: 303, headers: { Location: "/" } });
  }

  const rl = rateLimitCheck("signup", ctx.ip);
  if (!rl.allowed) {
    const headers: Record<string, string> = {};
    if (rl.retryAfterSec) headers["Retry-After"] = String(rl.retryAfterSec);
    return htmlResponse(
      layout({
        title: "Too many attempts",
        heading: "Slow down",
        body: h`<p>Please wait ${String(rl.retryAfterSec ?? 60)} seconds before requesting another code.</p>`,
      }),
      { status: 429, headers },
    );
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

  const pending = decodePendingVerifyCookie(req);
  if (!pending) return noPendingResponse();

  // Look up the row; only re-issue if the user exists AND is unverified.
  // If the cookie points at a verified user (the enumeration-resistant
  // case-A from /signup), we render the same "fresh code sent" page WITHOUT
  // actually sending anything — same enumeration shield.
  const row = await queryOne<{ username: string; email: string; email_verified: number }>(
    "SELECT username, email, email_verified FROM users WHERE id = ?",
    [pending.userId],
  );
  if (!row) return noPendingResponse();

  if (emailCapReached()) {
    const { token, setCookie } = tokenForRequest(req);
    return renderVerifyPage({
      csrfToken: token,
      csrfSetCookie: setCookie,
      email: row.email,
      error: "Email sending is temporarily paused. Please try again later.",
      status: 503,
    });
  }

  if (row.email_verified === 0) {
    const code = await issueVerificationCode(pending.userId);
    void sendVerificationCode({ to: row.email, code, username: row.username });
  }

  const { token, setCookie } = tokenForRequest(req);
  return renderVerifyPage({
    csrfToken: token,
    csrfSetCookie: setCookie,
    email: row.email,
    notice: "If we know that address, a fresh code is on the way.",
  });
}
