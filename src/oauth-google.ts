/**
 * Google OAuth 2.0 / OpenID Connect via `arctic`.
 *
 * Why arctic: small, focused, by the lucia-auth maintainer; handles state
 * (CSRF), PKCE, and token exchange correctly. We use it only for the OAuth
 * dance — session lifecycle stays in auth.ts.
 *
 * State + PKCE storage:
 *   - We need to remember `state` (CSRF) and `codeVerifier` (PKCE) between
 *     the user clicking "Continue with Google" and Google redirecting them
 *     back to our /callback. Two reasonable options: a DB row, or a cookie.
 *   - We use an HMAC-signed HttpOnly cookie keyed only to this request,
 *     scoped to /oauth/google/callback. That keeps the state out of the DB
 *     and makes the flow self-contained — the cookie IS the resumption
 *     ticket. 10-minute TTL.
 *   - Cookie format: `state.codeVerifier.expiresMs.hmac` where the HMAC
 *     covers the first three fields with SESSION_SECRET. timingSafeEqual
 *     on verify. An attacker without SESSION_SECRET cannot forge a cookie
 *     that survives verification.
 */
import { Google, generateState, generateCodeVerifier, decodeIdToken, type OAuth2Tokens } from "arctic";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { parseCookie } from "./auth.ts";

const COOKIE_NAME = "eah_oauth_google";
const STATE_TTL_MS = 10 * 60 * 1000;

/** True if Google OAuth is configured. Toggles the UI + route gates. */
export function googleOAuthEnabled(): boolean {
  return (
    config.googleOAuth.clientId.length > 0 &&
    config.googleOAuth.clientSecret.length > 0
  );
}

let _client: Google | null = null;
function client(): Google {
  if (_client) return _client;
  if (!googleOAuthEnabled()) {
    throw new Error("Google OAuth is not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)");
  }
  _client = new Google(
    config.googleOAuth.clientId,
    config.googleOAuth.clientSecret,
    config.googleOAuth.redirectUri,
  );
  return _client;
}

// -- State cookie ------------------------------------------------------------

function sign(payload: string): string {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("hex");
}

interface OAuthState {
  state: string;
  codeVerifier: string;
}

/** Build the Set-Cookie header for the state/PKCE ticket. */
function encodeStateCookie(state: string, codeVerifier: string): string {
  const expires = Date.now() + STATE_TTL_MS;
  const payload = `${state}.${codeVerifier}.${expires}`;
  const mac = sign(payload);
  const value = `${payload}.${mac}`;
  return (
    `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/oauth/google/callback; Max-Age=${Math.floor(STATE_TTL_MS / 1000)}`
  );
}

/** Verify + parse the state cookie. Returns null on any inconsistency. */
function decodeStateCookie(req: Request): OAuthState | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const raw = parseCookie(header, COOKIE_NAME);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [state, codeVerifier, expiresStr, mac] = parts;
  if (!state || !codeVerifier || !expiresStr || !mac) return null;
  // Format restrictions defend against weird inputs even before HMAC check.
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(state)) return null;
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(codeVerifier)) return null;
  if (!/^\d+$/.test(expiresStr)) return null;
  if (!/^[a-f0-9]{64}$/.test(mac)) return null;
  const expected = sign(`${state}.${codeVerifier}.${expiresStr}`);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(mac, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (parseInt(expiresStr, 10) < Date.now()) return null;
  return { state, codeVerifier };
}

/** Set-Cookie that clears the state cookie. Use after callback success/failure. */
export function clearStateCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/oauth/google/callback; Max-Age=0`;
}

// -- Public helpers ----------------------------------------------------------

/**
 * Build the URL to redirect the user to. Caller must also send the
 * `setCookie` header on the same response.
 */
export function startAuthorization(): { url: string; setCookie: string } {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = client().createAuthorizationURL(state, codeVerifier, [
    "openid",
    "email",
    "profile",
  ]);
  return { url: url.toString(), setCookie: encodeStateCookie(state, codeVerifier) };
}

export interface GoogleIdentity {
  sub: string;        // stable Google user ID
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/**
 * Exchange the callback's `code` for a Google identity. Returns null on any
 * validation failure — caller renders a generic "Google sign-in failed"
 * page so we don't leak exactly which check tripped (state mismatch vs.
 * Google's rejection, etc.).
 */
export async function handleCallback(req: Request, url: URL): Promise<GoogleIdentity | null> {
  if (!googleOAuthEnabled()) return null;

  // The state in the query must match the state in the cookie. arctic does
  // NOT enforce this for you — it's our responsibility to compare.
  const cookieState = decodeStateCookie(req);
  if (!cookieState) return null;
  const queryState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!queryState || !code) return null;

  const a = Buffer.from(cookieState.state);
  const b = Buffer.from(queryState);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let tokens: OAuth2Tokens;
  try {
    tokens = await client().validateAuthorizationCode(code, cookieState.codeVerifier);
  } catch {
    return null;
  }

  // The ID token is signed by Google. arctic's `decodeIdToken` just decodes
  // the JWT payload — and that's fine because we received the token over
  // TLS directly from Google's token endpoint. We do NOT trust ID tokens
  // received from anywhere else.
  let claims: Record<string, unknown>;
  try {
    const idToken = tokens.idToken();
    claims = decodeIdToken(idToken) as Record<string, unknown>;
  } catch {
    return null;
  }

  const sub = typeof claims["sub"] === "string" ? claims["sub"] : null;
  const email = typeof claims["email"] === "string" ? claims["email"] : null;
  const emailVerified = claims["email_verified"] === true;
  const name = typeof claims["name"] === "string" ? claims["name"] : null;

  if (!sub || !email) return null;
  // Refuse unverified Google emails. Google sets email_verified=false on
  // self-hosted-domain accounts that haven't completed DNS proof; we don't
  // want to auto-link those to existing password accounts.
  if (!emailVerified) return null;

  return { sub, email: email.toLowerCase(), emailVerified, name };
}
