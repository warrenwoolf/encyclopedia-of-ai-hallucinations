/**
 * Google Identity Services (GIS) server-side helpers.
 *
 * We verify the ID token (credential) POSTed from the client by validating the
 * JWT *locally* against Google's published public keys (JWKS), rather than
 * calling Google's `tokeninfo` introspection endpoint on every sign-in. Local
 * verification is lower-latency, doesn't depend on Google being reachable on
 * the hot path (once keys are cached), and isn't subject to tokeninfo rate
 * limits.
 *
 * Security notes for future readers:
 *   - We pin the algorithm to RS256 and ONLY ever import RSA verification keys.
 *     This is the defense against algorithm-confusion attacks (e.g. a forged
 *     header claiming `alg: none` or `alg: HS256` where the "signature" is an
 *     HMAC using the public key as the secret). A token whose header alg isn't
 *     exactly RS256 is rejected before any key is touched.
 *   - We verify the signature BEFORE trusting any claim in the payload.
 *   - We check issuer, audience (our client id), expiry (with small skew), and
 *     `email_verified` — same claim set the tokeninfo path checked, plus a
 *     local clock check and an issued-at sanity bound.
 *
 * No JWT library: the verification is small and fully auditable, and Bun ships
 * WebCrypto (`crypto.subtle`) which imports JWK RSA keys and verifies RS256
 * natively. Adding a dependency here would be more surface than the ~40 lines
 * it replaces.
 */
import { config } from "./config.ts";

export interface GoogleIdentity {
  sub: string;        // stable Google user ID
  email: string;
  emailVerified: boolean;
  name: string | null;
}

// Google's RSA signing keys (JWK Set). Both issuer spellings are valid in
// Google ID tokens.
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const VALID_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// Clock skew tolerance for exp / iat checks.
const CLOCK_SKEW_SEC = 60;

// JWKS cache tuning. We honor the response's Cache-Control max-age, clamped to
// a sane range so a misconfigured/hostile cache header can't pin us to a
// rotated-out key forever or force a fetch on every request.
const FALLBACK_TTL_MS = 60 * 60 * 1000;        // 1h if no/short cache header
const MAX_TTL_MS = 24 * 60 * 60 * 1000;        // never trust a cached set > 24h
// When a token references an unknown `kid` (Google rotates keys), we refresh —
// but never more than once per this interval, so a flood of tokens bearing
// bogus kids can't turn into a fetch amplification against Google.
const MIN_MISS_REFRESH_MS = 60 * 1000;

interface JwkSet {
  keys: Map<string, CryptoKey>;
  expiresAt: number;
}

let jwksCache: JwkSet | null = null;
let lastFetchMs = 0;
let inflight: Promise<JwkSet | null> | null = null;

export function googleOAuthEnabled(): boolean {
  return config.googleOAuth.clientId.length > 0;
}

interface RawJwk {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/** Fetch + import Google's JWKS. Throws on any failure so callers can fall
 * back to the (possibly stale) cache. */
async function fetchJwks(): Promise<JwkSet> {
  const resp = await fetch(JWKS_URL);
  if (!resp.ok) throw new Error(`jwks fetch returned ${resp.status}`);
  const body = (await resp.json()) as { keys?: RawJwk[] };
  if (!body || !Array.isArray(body.keys)) throw new Error("jwks response malformed");

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    if (jwk.kty !== "RSA" || !jwk.kid || !jwk.n || !jwk.e) continue;
    if (jwk.alg && jwk.alg !== "RS256") continue; // only RS256 signing keys
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch (err) {
      console.warn(`[oauth google] failed to import JWK kid=${jwk.kid}:`, err);
    }
  }
  if (keys.size === 0) throw new Error("jwks contained no usable RSA keys");

  let ttl = FALLBACK_TTL_MS;
  const cc = resp.headers.get("cache-control");
  const m = cc?.match(/max-age=(\d+)/i);
  if (m) {
    const maxAge = parseInt(m[1]!, 10) * 1000;
    if (Number.isFinite(maxAge) && maxAge > 0) ttl = Math.min(maxAge, MAX_TTL_MS);
  }
  return { keys, expiresAt: Date.now() + ttl };
}

/** Refresh the cache, deduping concurrent callers via a shared in-flight
 * promise. On failure keeps (and returns) the existing cache. */
function refreshJwks(): Promise<JwkSet | null> {
  if (inflight) return inflight;
  lastFetchMs = Date.now();
  inflight = fetchJwks()
    .then((set) => {
      jwksCache = set;
      return set;
    })
    .catch((err) => {
      console.warn("[oauth google] JWKS refresh failed:", err);
      return jwksCache; // fall back to stale cache (may be null)
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Resolve the verification key for a given `kid`, refreshing if needed. */
async function getKey(kid: string): Promise<CryptoKey | null> {
  const now = Date.now();
  const cache = jwksCache;

  // No cache yet, or expired → must refresh.
  if (!cache || now >= cache.expiresAt) {
    const fresh = await refreshJwks();
    return fresh?.keys.get(kid) ?? null;
  }

  // Fresh cache but the kid is missing → likely a key rotation. Refresh, but
  // rate-limited so unknown-kid floods don't hammer Google.
  if (!cache.keys.has(kid)) {
    if (now - lastFetchMs >= MIN_MISS_REFRESH_MS) {
      const fresh = await refreshJwks();
      return fresh?.keys.get(kid) ?? null;
    }
    return null;
  }

  return cache.keys.get(kid) ?? null;
}

function decodeJsonSegment(seg: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(seg, "base64url").toString("utf8");
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Verify an ID token (credential) received from the client. Returns the
 * normalized identity, or null on ANY failure (malformed token, bad
 * signature, wrong issuer/audience, expired, unverified email, etc.).
 */
export async function verifyIdToken(idToken: string): Promise<GoogleIdentity | null> {
  if (!googleOAuthEnabled()) return null;
  if (!idToken || typeof idToken !== "string") return null;

  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = decodeJsonSegment(headerB64);
  if (!header) return null;
  // Pin to RS256 — reject "none", "HS256", or anything else BEFORE selecting a
  // key. This is the algorithm-confusion guard.
  if (header["alg"] !== "RS256") return null;
  const kid = typeof header["kid"] === "string" ? header["kid"] : null;
  if (!kid) return null;

  const key = await getKey(kid).catch(() => null);
  if (!key) return null;

  // Verify the signature over the exact signing input before reading claims.
  const signature = Buffer.from(sigB64, "base64url");
  if (signature.length === 0) return null;
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signature,
      signingInput,
    );
  } catch (err) {
    console.warn("[oauth google] signature verify threw:", err);
    return null;
  }
  if (!signatureValid) return null;

  // Signature is valid — now (and only now) trust the claims.
  const payload = decodeJsonSegment(payloadB64);
  if (!payload) return null;

  const iss = typeof payload["iss"] === "string" ? payload["iss"] : null;
  const aud = typeof payload["aud"] === "string" ? payload["aud"] : null;
  const sub = typeof payload["sub"] === "string" ? payload["sub"] : null;
  const email = typeof payload["email"] === "string" ? payload["email"] : null;
  const emailVerified = payload["email_verified"] === true || payload["email_verified"] === "true";
  const name = typeof payload["name"] === "string" ? payload["name"] : null;
  const exp = typeof payload["exp"] === "number" ? payload["exp"] : null;
  const iat = typeof payload["iat"] === "number" ? payload["iat"] : null;

  if (!iss || !VALID_ISSUERS.includes(iss)) return null;
  if (!aud || aud !== config.googleOAuth.clientId) return null;
  if (!sub || !email) return null;
  if (!emailVerified) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (exp === null || exp + CLOCK_SKEW_SEC < nowSec) return null;     // expired
  if (iat !== null && iat - CLOCK_SKEW_SEC > nowSec) return null;     // issued in the future

  return { sub, email: email.toLowerCase(), emailVerified: true, name };
}

/** Test-only: reset the in-memory JWKS cache so tests are deterministic. */
export function __resetJwksCacheForTests(): void {
  jwksCache = null;
  lastFetchMs = 0;
  inflight = null;
}
