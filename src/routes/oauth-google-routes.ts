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
  verifyIdToken,
} from "../oauth-google.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteContext } from "./types.ts";

async function notConfigured(): Promise<Response> {
  return htmlResponse(
    await layout({
      title: "Not found · EAH",
      heading: "Not found",
      body: h`<p>Google sign-in isn't configured on this server.</p>`,
    }),
    { status: 404 },
  );
}

async function failure(reason: string): Promise<Response> {
  // Generic message — we don't leak which check failed (state mismatch vs.
  // Google rejection vs. cookie missing). The console log carries the detail
  // for operators.
  console.warn(`[oauth google] failed:`, reason);
  return htmlResponse(
    await layout({
      title: "Sign-in failed · EAH",
      heading: "Sign-in failed",
      body: h`<p>Google sign-in didn't complete. Try again or use a password.</p>
              <p><a href="/login">Back to sign in</a></p>`,
    }),
    { status: 400 },
  );
}

export async function postOauthStart(req: Request, ctx: RouteContext): Promise<Response> {
  // Legacy redirect flow is no longer supported; encourage the embedded GIS flow.
  return await notConfigured();
}

/**
 * POST handler for GIS credential verification. Expects a form POST with
 * `credential` (the ID token) and `_csrf` (CSRF token). The client-side
 * widget should post the credential and include the CSRF token so the
 * request is protected from CSRF.
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

  // Reuse the same user resolution logic from the old callback path.
  const userId: number = await transaction(async (tx) => {
    const bySub = await tx.queryOne<{ id: number }>("SELECT id FROM users WHERE google_sub = ? LIMIT 1", [identity.sub]);
    if (bySub) return bySub.id;

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
      return byEmail.id;
    }

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

  if (userId < 0) return await failure("user resolution failed");

  const { cookie: sessionCookie } = await createSession(userId);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", sessionCookie);
  return new Response(null, { status: 303, headers });
}

/**
 * Synthesize a username from an email's local part. Strip anything not
 * matching the username charset, then clamp length. Falls back to "user"
 * if everything was stripped.
 */
// Math.random() is used for username suffix disambiguation — this is not a
// security-sensitive value (username is public), so crypto-random is not required.
function synthesizeUsername(email: string): string {
  const at = email.indexOf("@");
  const local = at > 0 ? email.slice(0, at) : email;
  const sanitized = sanitizeText(local).replace(/[^A-Za-z0-9_.-]/g, "");
  const clipped = sanitized.slice(0, 32);
  if (clipped.length >= 3) return clipped;
  return `user${Math.floor(1000 + Math.random() * 9000)}`;
}
