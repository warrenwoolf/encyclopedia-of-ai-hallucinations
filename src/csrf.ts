/**
 * CSRF protection via a signed double-submit cookie.
 *
 * - On any GET that may render a form, we ensure a `eah_csrf=<token>` cookie is set.
 * - Every form embeds the token as a hidden field `_csrf`.
 * - On POST, the hidden field must equal the cookie. Both are validated via HMAC
 *   so an attacker can't pre-compute or forge a token without the server secret.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { parseCookie } from "./auth.ts";

const COOKIE_NAME = "eah_csrf";
const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function sign(payload: string): string {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("hex");
}

/** Token format: `<random>.<expiresAtMs>.<hmac>` */
function makeToken(): string {
  const nonce = randomBytes(16).toString("hex");
  const expires = Date.now() + TTL_MS;
  const payload = `${nonce}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

function isValidToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [nonce, expiresStr, mac] = parts;
  if (!nonce || !expiresStr || !mac) return false;
  if (!/^[a-f0-9]{32}$/.test(nonce)) return false;
  if (!/^\d+$/.test(expiresStr)) return false;
  if (!/^[a-f0-9]{64}$/.test(mac)) return false;
  const expected = sign(`${nonce}.${expiresStr}`);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(mac, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  if (parseInt(expiresStr, 10) < Date.now()) return false;
  return true;
}

/**
 * Get the token already in the cookie, or generate a new one.
 *
 * Memoized per Request via a WeakMap: callers can invoke this multiple times
 * within the same request handler (e.g. once from the route for its own form
 * and once from `layout.pageResponse` for the logout-button form) and will
 * receive the same token. Without this, `setCookie` would not match the form
 * field when the cookie is absent, because each call would mint a fresh
 * token. The WeakMap is GC'd with the request, no leak.
 */
// Memoized per Request object. Safe because Bun creates a new Request per
// HTTP connection — no two concurrent requests share the same Request instance.
// If this assumption ever changes, this cache will need to be keyed differently.
const perRequestCache = new WeakMap<Request, { token: string; setCookie: string | null }>();

export function tokenForRequest(req: Request): { token: string; setCookie: string | null } {
  const cached = perRequestCache.get(req);
  if (cached) return cached;
  const cookieHeader = req.headers.get("cookie") ?? "";
  const existing = parseCookie(cookieHeader, COOKIE_NAME);
  let result: { token: string; setCookie: string | null };
  if (existing && isValidToken(existing)) {
    result = { token: existing, setCookie: null };
  } else {
    const token = makeToken();
    const setCookie =
      `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; ` +
      `Max-Age=${Math.floor(TTL_MS / 1000)}`;
    result = { token, setCookie };
  }
  perRequestCache.set(req, result);
  return result;
}

/** Validate a POST: form `_csrf` field must match the cookie and be HMAC-valid. */
export function verifyCsrf(req: Request, formToken: string | undefined | null): boolean {
  if (!formToken) return false;
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookieToken = parseCookie(cookieHeader, COOKIE_NAME);
  if (!cookieToken) return false;
  if (!isValidToken(cookieToken)) return false;
  if (cookieToken.length !== formToken.length) return false;
  return timingSafeEqual(Buffer.from(cookieToken), Buffer.from(formToken));
}
