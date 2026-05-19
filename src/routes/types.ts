/**
 * Shared route handler types and small HTTP helpers used by every route.
 */
import type { AdminSession } from "../auth.ts";

export interface RouteContext {
  params: Record<string, string>;
  url: URL;
  ip: string;
  admin: AdminSession | null;
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

/** Parse application/x-www-form-urlencoded with a size cap. */
export async function parseForm(req: Request, maxBytes = 64 * 1024): Promise<URLSearchParams> {
  const text = await req.text();
  if (text.length > maxBytes) throw new Error("form too large");
  return new URLSearchParams(text);
}
