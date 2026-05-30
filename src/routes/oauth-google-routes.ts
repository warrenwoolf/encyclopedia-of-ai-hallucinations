/**
 * Google sign-in (Google Identity Services).
 *
 *   POST /oauth/google/verify  — verify the GIS ID token, then either sign an
 *                                existing user in OR (for a brand-new account)
 *                                hand off to the username-picker.
 *   GET  /choose-username      — new Google users pick a username here.
 *   POST /choose-username      — create the account with the chosen username.
 *
 * Why the username picker: a Google sign-in proves an email, but we never want
 * to silently use the email (or its local part) as the public username — the
 * username is shown publicly next to entries. So a NEW account is NOT created
 * when the token verifies; instead we stash the verified identity (Google
 * subject id + email) in a short-lived, HMAC-signed cookie scoped to
 * /choose-username and let the user choose. Existing users (matched by
 * google_sub, or by a verified email we can link) skip straight to a session.
 */
import { h, raw, type SafeHtml } from "../html.ts";
import { layout } from "../layout.ts";
import { queryOne, transaction } from "../db.ts";
import {
  createSession,
  encodePendingGoogleCookie,
  decodePendingGoogleCookie,
  clearPendingGoogleCookie,
} from "../auth.ts";
import { tokenForRequest, verifyCsrf } from "../csrf.ts";
import { check as rateLimitCheck } from "../ratelimit.ts";
import { googleOAuthEnabled, verifyIdToken } from "../oauth-google.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteContext } from "./types.ts";

const USERNAME_RE = /^[A-Za-z0-9_. -]{3,40}$/;

// Shared blurb about how the username drives public attribution. Also shown on
// the login and signup pages.
export const attributionNote: SafeHtml = h`
  <p class="field-hint"><small>Your <strong>username is shown publicly</strong> as
  the author of any entry you submit. If you'd like to be credited by name, use
  your first and last name as your username. Prefer not to be named? You can mark
  any individual submission as anonymous to the public when you submit it.</small></p>
`;

async function notConfigured(): Promise<Response> {
  return htmlResponse(
    await layout({
      title: "Not found · ENAIH",
      heading: "Not found",
      body: h`<p>Google sign-in isn't configured on this server.</p>`,
    }),
    { status: 404 },
  );
}

async function failure(reason: string): Promise<Response> {
  // Generic message — we don't leak which check failed. The console log carries
  // the detail for operators.
  console.warn(`[oauth google] failed:`, reason);
  return htmlResponse(
    await layout({
      title: "Sign-in failed · ENAIH",
      heading: "Sign-in failed",
      body: h`<p>Google sign-in didn't complete. Try again or use a password.</p>
              <p><a href="/login">Back to sign in</a></p>`,
    }),
    { status: 400 },
  );
}

export async function postOauthStart(req: Request, ctx: RouteContext): Promise<Response> {
  // Legacy redirect flow is no longer supported; the embedded GIS flow is used.
  return await notConfigured();
}

/**
 * Verify a GIS credential (ID token). On success: sign an existing user in, or
 * redirect a new user to /choose-username with a signed identity cookie.
 */
export async function postGisVerify(req: Request, ctx: RouteContext): Promise<Response> {
  if (!googleOAuthEnabled()) return await notConfigured();

  const rl = rateLimitCheck("oauth", ctx.ip);
  if (!rl.allowed) {
    return htmlResponse(
      await layout({ title: "Too many attempts", heading: "Slow down", body: h`<p>Please wait a bit before retrying.</p>` }),
      { status: 429 },
    );
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req);
  } catch {
    return htmlResponse(
      await layout({ title: "Bad request", heading: "Bad request", body: h`<p>The form submission was too large or malformed.</p>` }),
      { status: 400 },
    );
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    return htmlResponse(
      await layout({ title: "Invalid CSRF token", heading: "Invalid CSRF token", body: h`<p>Please go back and try again.</p>` }),
      { status: 403 },
    );
  }

  const credential = form.get("credential");
  if (!credential || typeof credential !== "string") return await failure("missing credential");

  const identity = await verifyIdToken(credential);
  if (!identity) return await failure("invalid token");

  // Resolve to an EXISTING user only. A brand-new account is created later, in
  // /choose-username, once the user has picked a username.
  let outcome: { kind: "existing"; id: number } | { kind: "new" };
  try {
    outcome = await transaction(async (tx) => {
      const bySub = await tx.queryOne<{ id: number }>("SELECT id FROM users WHERE google_sub = ? LIMIT 1", [identity.sub]);
      if (bySub) return { kind: "existing" as const, id: bySub.id };

      const byEmail = await tx.queryOne<{ id: number; email_verified: number; google_sub: string | null }>(
        "SELECT id, email_verified, google_sub FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
        [identity.email],
      );
      if (byEmail) {
        if (byEmail.google_sub !== null) {
          throw new Error("oauth link conflict (different google_sub already linked)");
        }
        if (byEmail.email_verified !== 1) {
          throw new Error("oauth link conflict (existing unverified password account)");
        }
        await tx.execute("UPDATE users SET google_sub = ? WHERE id = ?", [identity.sub, byEmail.id]);
        return { kind: "existing" as const, id: byEmail.id };
      }

      return { kind: "new" as const };
    });
  } catch (err) {
    console.error("[oauth google] user resolution failed:", err);
    return await failure("user resolution failed");
  }

  if (outcome.kind === "new") {
    // Defer account creation: stash the verified identity and send the user to
    // pick a username.
    const headers = new Headers({ Location: "/choose-username" });
    headers.append("Set-Cookie", encodePendingGoogleCookie({ sub: identity.sub, email: identity.email }));
    return new Response(null, { status: 303, headers });
  }

  const { cookie: sessionCookie } = await createSession(outcome.id);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", sessionCookie);
  return new Response(null, { status: 303, headers });
}

/**
 * Suggest a starting username from an email's local part. Strip anything not
 * matching the username charset, then clamp length. Falls back to "user" if
 * everything was stripped. This is only a SUGGESTION the user can change — it's
 * never silently committed.
 */
function suggestUsername(email: string): string {
  const at = email.indexOf("@");
  const local = at > 0 ? email.slice(0, at) : email;
  const sanitized = sanitizeText(local).replace(/[^A-Za-z0-9_.-]/g, "");
  const clipped = sanitized.slice(0, 32);
  if (clipped.length >= 3) return clipped;
  return "";
}

function renderChoosePage(opts: {
  csrf: string;
  setCookie?: string | null;
  email: string;
  suggested: string;
  error?: string | null;
  status?: number;
}): Response {
  const errBlock: SafeHtml = opts.error
    ? h`<p class="error" role="alert">${opts.error}</p>`
    : raw("");
  const body = h`
    <p>You're signing in with <strong>${opts.email}</strong>. Pick a username to
       finish creating your account.</p>
    ${attributionNote}
    ${errBlock}
    <form method="post" action="/choose-username" autocomplete="off">
      <input type="hidden" name="_csrf" value="${opts.csrf}">
      <p>
        <label for="username">Username</label><br>
        <small class="muted">3–40 chars: letters, digits, spaces, and _ . -</small><br>
        <input type="text" id="username" name="username"
               value="${opts.suggested}" minlength="3" maxlength="40"
               required autofocus autocomplete="username">
      </p>
      <p>
        <button type="submit">Create account</button>
      </p>
    </form>
  `;
  return htmlResponse(
    layout({ title: "Choose a username · ENAIH", heading: "Choose a username", body }),
    { status: opts.status ?? 200, setCookie: opts.setCookie },
  );
}

export async function getChooseUsername(req: Request, ctx: RouteContext): Promise<Response> {
  if (ctx.user) return new Response(null, { status: 303, headers: { Location: "/" } });

  const pending = decodePendingGoogleCookie(req);
  if (!pending) {
    // Cookie missing/expired — start over.
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  const { token, setCookie } = tokenForRequest(req);
  return renderChoosePage({
    csrf: token,
    setCookie,
    email: pending.email,
    suggested: suggestUsername(pending.email),
  });
}

export async function postChooseUsername(req: Request, ctx: RouteContext): Promise<Response> {
  if (ctx.user) return new Response(null, { status: 303, headers: { Location: "/" } });

  const rl = rateLimitCheck("oauth", ctx.ip);
  if (!rl.allowed) {
    return htmlResponse(
      await layout({ title: "Too many attempts", heading: "Slow down", body: h`<p>Please wait a bit before retrying.</p>` }),
      { status: 429 },
    );
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req);
  } catch {
    return htmlResponse(
      await layout({ title: "Bad request", heading: "Bad request", body: h`<p>The form submission was too large or malformed.</p>` }),
      { status: 400 },
    );
  }
  if (!verifyCsrf(req, form.get("_csrf"))) {
    return htmlResponse(
      await layout({ title: "Invalid CSRF token", heading: "Invalid CSRF token", body: h`<p>Please go back and try again.</p>` }),
      { status: 403 },
    );
  }

  const pending = decodePendingGoogleCookie(req);
  if (!pending) return new Response(null, { status: 303, headers: { Location: "/login" } });

  const username = sanitizeText((form.get("username") ?? "").trim());

  const rerender = (error: string, status: number) => {
    const { token, setCookie } = tokenForRequest(req);
    return renderChoosePage({
      csrf: token, setCookie, email: pending.email, suggested: username, error, status,
    });
  };

  if (!USERNAME_RE.test(username)) {
    return rerender("Username must be 3–40 chars: letters, digits, spaces, underscore, dot, or hyphen.", 400);
  }

  const taken = await queryOne<{ id: number }>(
    "SELECT id FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1",
    [username],
  );
  if (taken) return rerender("That username is already taken. Pick another.", 409);

  // Create the account (google_sub + verified email, no password). Handle a
  // double-submit race: if this google_sub already exists, just sign that user
  // in; if the username collided concurrently, re-prompt.
  let userId: number;
  try {
    userId = await transaction(async (tx) => {
      const bySub = await tx.queryOne<{ id: number }>(
        "SELECT id FROM users WHERE google_sub = ? LIMIT 1",
        [pending.sub],
      );
      if (bySub) return bySub.id;
      const ins = await tx.execute(
        `INSERT INTO users (username, email, email_verified, password_hash, google_sub, is_admin)
         VALUES (?, ?, 1, NULL, ?, 0)`,
        [username, pending.email, pending.sub],
      );
      return ins.insertId;
    });
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) {
      // Could be username OR email/sub. The username check above already passed,
      // so most likely a concurrent insert — re-prompt generically.
      return rerender("That username is already taken. Pick another.", 409);
    }
    console.error("[choose-username] account creation failed:", err);
    return await failure("account creation failed");
  }

  const { cookie } = await createSession(userId);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", cookie);
  headers.append("Set-Cookie", clearPendingGoogleCookie());
  return new Response(null, { status: 303, headers });
}
