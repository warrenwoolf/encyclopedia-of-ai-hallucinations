/**
 * Admin authentication: bcrypt password verification and session cookie issue/verify.
 *
 * Sessions: a 32-byte random token is sent to the client as `eah_session=<hex>`.
 * The server stores only sha256(token) in `admin_sessions.token_hash`.
 */
import bcrypt from "bcryptjs";
import { randomBytes, createHash } from "node:crypto";
import { execute, queryOne } from "./db.ts";

const BCRYPT_COST = 12;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = "eah_session";

export async function hashPassword(plain: string): Promise<string> {
  return await bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

function sha256Hex(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export async function createSession(adminId: number): Promise<{ cookie: string; token: string }> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await execute(
    "INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)",
    [tokenHash, adminId, expiresAt],
  );
  const cookie =
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; ` +
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  return { cookie, token };
}

export async function destroySession(token: string): Promise<void> {
  const tokenHash = sha256Hex(token);
  await execute("DELETE FROM admin_sessions WHERE token_hash = ?", [tokenHash]);
}

export interface AdminSession {
  adminId: number;
  username: string;
  token: string;
}

export async function getSessionFromRequest(req: Request): Promise<AdminSession | null> {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;
  const token = parseCookie(cookieHeader, COOKIE_NAME);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = sha256Hex(token);
  const row = await queryOne<{ admin_id: number; username: string; expires_at: Date }>(
    `SELECT s.admin_id, a.username, s.expires_at
       FROM admin_sessions s
       JOIN admins a ON a.id = s.admin_id
       WHERE s.token_hash = ?`,
    [tokenHash],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await execute("DELETE FROM admin_sessions WHERE token_hash = ?", [tokenHash]);
    return null;
  }
  return { adminId: row.admin_id, username: row.username, token };
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
    await execute("DELETE FROM admin_sessions WHERE expires_at < NOW()");
  } catch {
    // ignore; will retry on next tick
  }
}
