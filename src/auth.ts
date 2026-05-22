/**
 * User authentication: password hashing, session cookies, and the
 * email-verification code workflow.
 *
 * Unified accounts model — admins are users with `is_admin=1`. Everything
 * authentication-related goes through this module.
 *
 * Password hashing: argon2id via `Bun.password`. No other algorithms are
 * supported — `verifyPassword` returns false for any non-argon2 hash. If
 * we ever need to migrate hashes again, do it with a password-reset flow,
 * not by reintroducing a verify-other-algorithm branch.
 *
 * Sessions:
 *   - 32-byte random token sent to the client as `eah_session=<hex>`.
 *   - DB stores only sha256(token). A stolen DB dump is not a session-takeover
 *     vector — only the cookie value is.
 *   - Sliding window via expires_at; the session-purge interval (server.ts)
 *     deletes expired rows. We DO NOT extend on use; sessions live 7 days
 *     then require re-login. This keeps the cookie validity window bounded.
 */
import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { execute, queryOne, transaction } from "./db.ts";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = "eah_session";

const PENDING_VERIFY_COOKIE = "eah_pending_verify";
const PENDING_VERIFY_TTL_MS = 15 * 60 * 1000;

// 6-digit verification codes. Short TTL + capped attempts is the entire
// defense against brute force; 6 digits = ~20 bits, so 15-min TTL × 5 tries
// per row is comfortably safe.
const VERIFY_CODE_TTL_MS = 15 * 60 * 1000;
const VERIFY_MAX_ATTEMPTS = 5;

// -- Password hashing --------------------------------------------------------

/**
 * Hash a plaintext password. Always argon2id for new hashes.
 *
 * Caller MUST length-cap the input before calling: argon2 is intentionally
 * slow and unbounded input is a CPU DoS.
 */
export async function hashPassword(plain: string): Promise<string> {
  return await Bun.password.hash(plain, { algorithm: "argon2id" });
}

/**
 * Verify a plaintext password against a stored hash. Returns false on any
 * error (malformed hash, decode failure, etc.) — never throws. Only argon2
 * hashes are accepted; anything else returns false.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash || !hash.startsWith("$argon2")) return false;
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}

// -- Sessions ----------------------------------------------------------------

function sha256(s: string | Buffer): Buffer {
  return createHash("sha256").update(s).digest();
}

export interface UserSession {
  userId: number;
  username: string;
  email: string;
  isAdmin: boolean;
  emailVerified: boolean;
  token: string;
}

export async function createSession(userId: number): Promise<{ cookie: string; token: string }> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await execute(
    "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    [tokenHash, userId, expiresAt],
  );
  // Also stamp last_login_at — best-effort, non-fatal.
  try {
    await execute("UPDATE users SET last_login_at = NOW() WHERE id = ?", [userId]);
  } catch {}
  const cookie =
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; ` +
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  return { cookie, token };
}

export async function destroySession(token: string): Promise<void> {
  const tokenHash = sha256(token);
  await execute("DELETE FROM user_sessions WHERE token_hash = ?", [tokenHash]);
}

export async function getSessionFromRequest(req: Request): Promise<UserSession | null> {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;
  const token = parseCookie(cookieHeader, COOKIE_NAME);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = sha256(token);
  const row = await queryOne<{
    user_id: number;
    username: string;
    email: string;
    is_admin: number;
    email_verified: number;
    expires_at: Date;
  }>(
    `SELECT s.user_id, u.username, u.email, u.is_admin, u.email_verified, s.expires_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    [tokenHash],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await execute("DELETE FROM user_sessions WHERE token_hash = ?", [tokenHash]);
    return null;
  }
  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    isAdmin: row.is_admin === 1,
    emailVerified: row.email_verified === 1,
    token,
  };
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function parseCookie(header: string, name: string): string | undefined {
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return undefined;
}

/** Periodic cleanup, called from server.ts on an interval. */
export async function purgeExpiredSessions(): Promise<void> {
  try {
    await execute("DELETE FROM user_sessions WHERE expires_at < NOW()");
    await execute("DELETE FROM email_verifications WHERE expires_at < NOW()");
    // Auto-delete unverified accounts older than 24h. They abandoned signup
    // (or never had a real signup — see /signup enumeration-resistance: any
    // race in which an existing pending row collides with a new signup
    // attempt leaves the original row to expire naturally). 24h is well
    // past the 15-minute pending-verify cookie TTL and well past any
    // legitimate "I'll finish later" window.
    await execute(
      `DELETE FROM users
        WHERE email_verified = 0
          AND is_admin = 0
          AND google_sub IS NULL
          AND created_at < NOW() - INTERVAL 24 HOUR`,
    );
  } catch {
    // ignore; retried next tick
  }
}

// -- Pending-verify cookie ---------------------------------------------------
//
// Used by /signup and /login to refer to a user that hasn't completed email
// verification yet. The cookie carries (userId, expires) plus an HMAC over
// the same values, so it's tamper-proof: an attacker without SESSION_SECRET
// can't point it at a different user.
//
// Why a cookie instead of just a session? Because we don't want unverified
// accounts to have a session at all — sessions imply "this user passed all
// auth checks". The pending cookie is a narrow, short-lived ticket for the
// verify flow only (Path=/verify scope means it isn't even sent to the rest
// of the site).
//
// Why is this here in auth.ts and not in a route handler? Because /signup
// and /login both issue these cookies, and /verify reads them. Keeping the
// encoding in one place makes it harder to get the HMAC wrong somewhere.

function hmacSign(payload: string): string {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("hex");
}

/** Build a Set-Cookie header for the pending-verify ticket pointing at `userId`. */
export function encodePendingVerifyCookie(userId: number): string {
  const expires = Date.now() + PENDING_VERIFY_TTL_MS;
  const payload = `${userId}.${expires}`;
  const mac = hmacSign(payload);
  const value = `${payload}.${mac}`;
  return (
    `${PENDING_VERIFY_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/verify; Max-Age=${Math.floor(PENDING_VERIFY_TTL_MS / 1000)}`
  );
}

/** Parse + verify the pending cookie on `req`. Returns null on any inconsistency. */
export function decodePendingVerifyCookie(req: Request): { userId: number } | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const raw = parseCookie(header, PENDING_VERIFY_COOKIE);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [uidStr, expiresStr, mac] = parts;
  if (!uidStr || !expiresStr || !mac) return null;
  if (!/^\d{1,12}$/.test(uidStr)) return null;
  if (!/^\d{1,15}$/.test(expiresStr)) return null;
  if (!/^[a-f0-9]{64}$/.test(mac)) return null;
  const expected = hmacSign(`${uidStr}.${expiresStr}`);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(mac, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (parseInt(expiresStr, 10) < Date.now()) return null;
  return { userId: parseInt(uidStr, 10) };
}

/** Set-Cookie that clears the pending-verify cookie. */
export function clearPendingVerifyCookie(): string {
  return `${PENDING_VERIFY_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/verify; Max-Age=0`;
}

// -- Email verification ------------------------------------------------------

function generateSixDigit(): string {
  // randomBytes(4) → 32 bits → modulo 1_000_000. Bias is < 1 part in 4000;
  // the slight non-uniformity does not affect security at this attempt cap.
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, "0");
}

/**
 * Issue a fresh 6-digit verification code for `userId`. Replaces any previous
 * outstanding code. Returns the plaintext code so the caller can email it.
 */
export async function issueVerificationCode(userId: number): Promise<string> {
  const code = generateSixDigit();
  const codeHash = sha256(code);
  const expiresAt = new Date(Date.now() + VERIFY_CODE_TTL_MS);
  // REPLACE INTO: upsert so requesting a new code invalidates the old one and
  // resets the attempt counter atomically.
  await execute(
    `REPLACE INTO email_verifications (user_id, code_hash, expires_at, attempts)
     VALUES (?, ?, ?, 0)`,
    [userId, codeHash, expiresAt],
  );
  return code;
}

/**
 * Check a code against the row for `userId`. Returns true and marks
 * `users.email_verified=1` (deleting the verification row) on success.
 *
 * Brute force defense:
 *   - VERIFY_MAX_ATTEMPTS strikes per (user, code) row, then the row is
 *     deleted and the user must request a new code.
 *   - constant-time compare of the SHA-256 hashes.
 */
export async function consumeVerificationCode(
  userId: number,
  code: string,
): Promise<{ ok: boolean; reason?: "expired" | "exhausted" | "mismatch" | "none" }> {
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, reason: "mismatch" };
  }
  return await transaction(async (tx) => {
    const row = await tx.queryOne<{ code_hash: Buffer; expires_at: Date; attempts: number }>(
      "SELECT code_hash, expires_at, attempts FROM email_verifications WHERE user_id = ?",
      [userId],
    );
    if (!row) return { ok: false, reason: "none" as const };
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await tx.execute("DELETE FROM email_verifications WHERE user_id = ?", [userId]);
      return { ok: false, reason: "expired" as const };
    }
    if (row.attempts >= VERIFY_MAX_ATTEMPTS) {
      await tx.execute("DELETE FROM email_verifications WHERE user_id = ?", [userId]);
      return { ok: false, reason: "exhausted" as const };
    }
    const candidate = sha256(code);
    const stored = Buffer.isBuffer(row.code_hash) ? row.code_hash : Buffer.from(row.code_hash);
    const equal = candidate.length === stored.length && timingSafeEqual(candidate, stored);
    if (!equal) {
      await tx.execute(
        "UPDATE email_verifications SET attempts = attempts + 1 WHERE user_id = ?",
        [userId],
      );
      return { ok: false, reason: "mismatch" as const };
    }
    // Success.
    await tx.execute("DELETE FROM email_verifications WHERE user_id = ?", [userId]);
    await tx.execute("UPDATE users SET email_verified = 1 WHERE id = ?", [userId]);
    return { ok: true };
  });
}
