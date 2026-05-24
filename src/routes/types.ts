/**
 * Shared route handler types and small HTTP helpers used by every route.
 */
import type { UserSession } from "../auth.ts";

export interface RouteContext {
  params: Record<string, string>;
  url: URL;
  ip: string;
  /** Logged-in user (admin or not), or null. */
  user: UserSession | null;
  /**
   * Same data as `user` but only set when the user is an admin. Lets admin
   * route handlers keep their `if (!ctx.admin) return authRedirect()` pattern
   * without an `isAdmin` check at every site. Non-admin users see this as
   * null even when logged in. NOTE: owners (is_owner=1) are included here —
   * they have all staff privileges plus account management.
   */
  admin: UserSession | null;
  /**
   * Same data as `user` but only set when the user is an owner. Account
   * management (promote/demote/suspend/delete, including managing other
   * owners) gates on this. Staff who are not owners see it as null.
   */
  owner: UserSession | null;
}

export type RouteHandler = (req: Request, ctx: RouteContext) => Promise<Response> | Response;

/** Send HTML with appropriate headers and optional Set-Cookie. */
export function htmlResponse(
  html: string,
  init?: { status?: number; setCookie?: string | null; headers?: Record<string, string> },
): Response {
  const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
  if (init?.setCookie) headers["Set-Cookie"] = init.setCookie;
  if (init?.headers) Object.assign(headers, init.headers);
  return new Response(html, { status: init?.status ?? 200, headers });
}

/**
 * Parse application/x-www-form-urlencoded with a strict size cap.
 *
 * Caps are enforced two ways:
 *   1. Reject up-front if Content-Length says it's too big.
 *   2. Stream the body and abort as soon as byte count exceeds the cap, so a
 *      lying Content-Length or chunked encoding still can't blow up memory.
 */
export async function parseForm(req: Request, maxBytes = 64 * 1024): Promise<URLSearchParams> {
  const clHeader = req.headers.get("content-length");
  if (clHeader) {
    const cl = parseInt(clHeader, 10);
    if (Number.isFinite(cl) && cl > maxBytes) throw new Error("form too large");
  }

  const body = req.body;
  if (!body) return new URLSearchParams();

  const reader = body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error("form too large");
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  return new URLSearchParams(text);
}

/**
 * Strip control characters and known-dangerous invisible Unicode from user
 * text. Preserves \t \n \r. Defense-in-depth at every submit/review entry
 * point — XSS is already prevented by the `h\`\`` escaper, but reviewer-facing
 * text shouldn't contain BiDi overrides ("Trojan Source") or arbitrary control
 * chars that mess with terminals if anyone copies it to a shell.
 */
const KEEP_LOW = new Set([0x09, 0x0A, 0x0D]); // tab, LF, CR

const SCRUB_CODEPOINTS = new Set<number>([
  // BiDi overrides + direction-isolate marks (Trojan Source)
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
  0x2066, 0x2067, 0x2068, 0x2069,
  // Zero-width spaces / joiners / non-joiner / BOM
  0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0xFEFF,
]);

export function sanitizeText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // C0 controls (0x00-0x1F): drop except \t \n \r
    if (code < 0x20) {
      if (KEEP_LOW.has(code)) out += s[i];
      continue;
    }
    // DEL + C1 controls (0x7F-0x9F): drop
    if (code >= 0x7F && code <= 0x9F) continue;
    if (SCRUB_CODEPOINTS.has(code)) continue;
    out += s[i];
  }
  return out;
}
