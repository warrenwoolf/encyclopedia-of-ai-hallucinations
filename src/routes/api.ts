/**
 * Lightweight API endpoints.
 *
 *   GET /api/username-check?u=<username>
 *     Returns {"available": true|false} (always 200 unless rate-limited → 429).
 *     Only checks username existence — intentionally does NOT reveal whether an
 *     email address is registered (enumeration resistance).
 */
import { queryOne } from "../db.ts";
import { check } from "../ratelimit.ts";
import type { RouteHandler } from "./types.ts";

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,40}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const usernameCheck: RouteHandler = async (_req, ctx) => {
  const result = check("api", ctx.ip);
  if (!result.allowed) {
    return json({ available: false }, 429);
  }

  const u = (ctx.url.searchParams.get("u") ?? "").trim();

  if (!USERNAME_RE.test(u)) {
    // Invalid format — treat as unavailable so the client shows an error.
    return json({ available: false });
  }

  const row = await queryOne<{ id: number }>(
    "SELECT id FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1",
    [u],
  );

  return json({ available: row === undefined });
};
