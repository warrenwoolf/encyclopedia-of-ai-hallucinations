/**
 * Google OAuth 2.0 routes.
 *
 *   POST /oauth/google/start    — CSRF-checked. Stamp state+PKCE cookie,
 *                                 302 to Google.
 *   GET  /oauth/google/callback — Google redirects here. Validate, find or
 *                                 create the user, create a session.
 *
 * The start route is POST so a CSRF token gates entry. That stops a malicious
 * site from sneaking users into our OAuth dance via a hidden iframe link.
 */
import { h } from "../html.ts";
import { layout } from "../layout.ts";
import { transaction } from "../db.ts";
import { createSession } from "../auth.ts";
import { verifyCsrf } from "../csrf.ts";
import { check as rateLimitCheck } from "../ratelimit.ts";
import {
  googleOAuthEnabled,
  startAuthorization,
  handleCallback,
  clearStateCookie,
} from "../oauth-google.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteContext } from "./types.ts";

function notConfigured(): Response {
  return htmlResponse(
    layout({
      title: "Not found · EAH",
      heading: "Not found",
      body: h`<p>Google sign-in isn't configured on this server.</p>`,
    }),
    { status: 404 },
  );
}

function failure(reason: string): Response {
  // Generic message — we don't leak which check failed (state mismatch vs.
  // Google rejection vs. cookie missing). The console log carries the detail
  // for operators.
  console.warn(`[oauth google] failed:`, reason);
  return htmlResponse(
    layout({
      title: "Sign-in failed · EAH",
      heading: "Sign-in failed",
      body: h`<p>Google sign-in didn't complete. Try again or use a password.</p>
              <p><a href="/login">Back to sign in</a></p>`,
    }),
    { status: 400, setCookie: clearStateCookie() },
  );
}

export async function postOauthStart(req: Request, ctx: RouteContext): Promise<Response> {
  if (!googleOAuthEnabled()) return notConfigured();

  const rl = rateLimitCheck("oauth", ctx.ip);
  if (!rl.allowed) {
    return htmlResponse(
      layout({
        title: "Too many attempts",
        heading: "Slow down",
        body: h`<p>Please wait a bit before retrying.</p>`,
      }),
      { status: 429 },
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
  if (!verifyCsrf(req, form.get("_csrf"))) {
    return htmlResponse(
      layout({
        title: "Invalid CSRF token",
        heading: "Invalid CSRF token",
        body: h`<p>Please go back and try again.</p>`,
      }),
      { status: 403 },
    );
  }

  const { url, setCookie } = startAuthorization();
  return new Response(null, {
    status: 303,
    headers: { Location: url, "Set-Cookie": setCookie },
  });
}

export async function getOauthCallback(req: Request, ctx: RouteContext): Promise<Response> {
  if (!googleOAuthEnabled()) return notConfigured();

  // If Google sent ?error= (user denied, etc), short-circuit.
  const oauthError = ctx.url.searchParams.get("error");
  if (oauthError) return failure(`google returned error=${oauthError}`);

  const identity = await handleCallback(req, ctx.url);
  if (!identity) return failure("invalid callback (state/code/identity)");

  // Find or create the user. Three cases:
  //   (1) google_sub already maps to a user — that's the canonical path. Log in.
  //   (2) no google_sub match, but email matches an existing verified user —
  //       LINK: stamp google_sub onto that user. (Account-link policy: yes.)
  //   (3) no match either way — CREATE a new user with a synthesized username.
  const userId: number = await transaction(async (tx) => {
    const bySub = await tx.queryOne<{ id: number }>(
      "SELECT id FROM users WHERE google_sub = ? LIMIT 1",
      [identity.sub],
    );
    if (bySub) return bySub.id;

    const byEmail = await tx.queryOne<{ id: number; email_verified: number; google_sub: string | null }>(
      "SELECT id, email_verified, google_sub FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
      [identity.email],
    );
    if (byEmail) {
      // Refuse linking if that email is on a *Google* account already (would
      // mean two distinct google_subs share an email — shouldn't happen, but
      // defend anyway). Refuse linking if email isn't verified — that path
      // is supposed to be the user demonstrating they own the email, but
      // they haven't yet, so linking is unsafe.
      if (byEmail.google_sub !== null) {
        throw new Error("oauth link conflict (different google_sub already linked)");
      }
      if (byEmail.email_verified !== 1) {
        throw new Error("oauth link conflict (existing unverified password account)");
      }
      await tx.execute(
        "UPDATE users SET google_sub = ? WHERE id = ?",
        [identity.sub, byEmail.id],
      );
      return byEmail.id;
    }

    // Create a new user. Synthesize a username from email-local-part, retrying
    // on collision with a numeric suffix. Username won't be perfect — the
    // user can be given a "change username" UI later if it matters.
    const base = synthesizeUsername(identity.email);
    let username = base;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await tx.execute(
          `INSERT INTO users (username, email, email_verified, password_hash, google_sub, is_admin)
           VALUES (?, ?, 1, NULL, ?, 0)`,
          [username, identity.email, identity.sub],
        );
        return res.insertId;
      } catch (err: any) {
        // Duplicate-key — try a fresh suffix.
        if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) {
          username = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
          continue;
        }
        throw err;
      }
    }
    throw new Error("could not allocate a unique username after retries");
  }).catch((err) => {
    console.error("[oauth google] user resolution failed:", err);
    return -1;
  });

  if (userId < 0) return failure("user resolution failed");

  const { cookie: sessionCookie } = await createSession(userId);

  // Two Set-Cookie headers: clear the oauth-state cookie AND set the session.
  // `Headers` is fine, but `Response` constructor's headers init dedupes
  // duplicates — we use `Headers.append` to keep both.
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", sessionCookie);
  headers.append("Set-Cookie", clearStateCookie());
  return new Response(null, { status: 303, headers });
}

/**
 * Synthesize a username from an email's local part. Strip anything not
 * matching the username charset, then clamp length. Falls back to "user"
 * if everything was stripped.
 */
function synthesizeUsername(email: string): string {
  const at = email.indexOf("@");
  const local = at > 0 ? email.slice(0, at) : email;
  const sanitized = sanitizeText(local).replace(/[^A-Za-z0-9_.-]/g, "");
  const clipped = sanitized.slice(0, 32);
  if (clipped.length >= 3) return clipped;
  return `user${Math.floor(1000 + Math.random() * 9000)}`;
}
