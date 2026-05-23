/**
 * Google Identity Services (GIS) server-side helpers.
 *
 * We verify the ID token (credential) POSTed from the client. For now we
 * verify using Google's tokeninfo endpoint which returns the token payload
 * if valid. This avoids adding a heavy JWT library; it's suitable for our
 * initial migration and keeps the code simple. In future we can switch to
 * local JWT verification via JWKS for lower latency and independence.
 */
import { config } from "./config.ts";

export interface GoogleIdentity {
  sub: string;        // stable Google user ID
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export function googleOAuthEnabled(): boolean {
  return config.googleOAuth.clientId.length > 0;
}

/** Verify an ID token (credential) received from the client. Returns the
 * normalized identity or null on failure. */
export async function verifyIdToken(idToken: string): Promise<GoogleIdentity | null> {
  if (!googleOAuthEnabled()) return null;
  if (!idToken || typeof idToken !== "string") return null;

  try {
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!resp.ok) return null;
    const payload = await resp.json() as Record<string, unknown>;

    // Validate audience and required claims.
    const aud = typeof payload["aud"] === "string" ? payload["aud"] : null;
    const sub = typeof payload["sub"] === "string" ? payload["sub"] : null;
    const email = typeof payload["email"] === "string" ? payload["email"] : null;
    const emailVerified = payload["email_verified"] === "true" || payload["email_verified"] === true;
    const name = typeof payload["name"] === "string" ? payload["name"] : null;

    if (!aud || aud !== config.googleOAuth.clientId) return null;
    if (!sub || !email) return null;
    if (!emailVerified) return null;

    return { sub, email: email.toLowerCase(), emailVerified, name };
  } catch (err) {
    console.warn("verifyIdToken error:", err);
    return null;
  }
}
