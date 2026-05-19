/**
 * Bun HTTP server entrypoint.
 *
 *   - Dispatches by method and path to one of the route handlers in src/routes/.
 *   - Loads the admin session (if any) and attaches to ctx.
 *   - Serves static assets from src/static/ under /static/*.
 *   - Adds security headers to every response.
 *   - /health returns "healthy" for the Docker healthcheck.
 */
import { config, isProd } from "./config.ts";
import { gc as ratelimitGc } from "./ratelimit.ts";
import { getSessionFromRequest, purgeExpiredSessions } from "./auth.ts";
import type { RouteContext, RouteHandler } from "./routes/types.ts";

import { home } from "./routes/home.ts";
import { entry } from "./routes/entry.ts";
import { browse } from "./routes/browse.ts";
import { submitGet, submitPost } from "./routes/submit.ts";
import { trackGet, trackWithdrawPost } from "./routes/track.ts";
import { about } from "./routes/about.ts";
import { getLogin, postLogin, postLogout } from "./routes/admin/login.ts";
import { getQueue, getQueueDetail } from "./routes/admin/queue.ts";
import { postReview } from "./routes/admin/review.ts";
import { getAll } from "./routes/admin/all.ts";

interface RouteDef {
  method: "GET" | "POST";
  pattern: RegExp;
  paramKeys: string[];
  handler: RouteHandler;
}

function route(method: "GET" | "POST", path: string, handler: RouteHandler): RouteDef {
  const paramKeys: string[] = [];
  const regexSrc = path.replace(/:([A-Za-z_]+)/g, (_m, key) => {
    paramKeys.push(key);
    return "([^/]+)";
  });
  return {
    method,
    pattern: new RegExp(`^${regexSrc}$`),
    paramKeys,
    handler,
  };
}

const ROUTES: RouteDef[] = [
  // Public
  route("GET", "/", home),
  route("GET", "/about", about),
  route("GET", "/browse", browse),
  route("GET", "/e/:public_id", entry),
  route("GET", "/submit", submitGet),
  route("POST", "/submit", submitPost),
  route("GET", "/track", trackGet),
  route("POST", "/track/withdraw", trackWithdrawPost),
  // Admin
  route("GET", "/admin/login", getLogin),
  route("POST", "/admin/login", postLogin),
  route("POST", "/admin/logout", postLogout),
  route("GET", "/admin/queue", getQueue),
  route("GET", "/admin/queue/:id", getQueueDetail),
  route("POST", "/admin/queue/:id", postReview),
  route("GET", "/admin/all", getAll),
];

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "Permissions-Policy": "interest-cohort=()",
};

function addSecurityHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  return res;
}

function clientIp(req: Request, server: { requestIP?: (req: Request) => { address: string } | null }): string {
  // Behind cloudflared, Cloudflare sets cf-connecting-ip with the real client IP.
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  try {
    const addr = server.requestIP?.(req);
    if (addr?.address) return addr.address;
  } catch {}
  return "0.0.0.0";
}

async function serveStatic(pathname: string): Promise<Response | null> {
  // Only allow /static/<file> with safe chars.
  if (!pathname.startsWith("/static/")) return null;
  const rest = pathname.slice("/static/".length);
  if (!/^[A-Za-z0-9._-]+$/.test(rest)) return null;
  const file = Bun.file(`./src/static/${rest}`);
  if (!(await file.exists())) return null;
  return new Response(file, {
    headers: {
      "Cache-Control": isProd ? "public, max-age=3600" : "no-cache",
    },
  });
}

async function handle(req: Request, server: any): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const pathname = url.pathname;

  // Health check (no headers, no session, no anything)
  if (pathname === "/health") {
    return new Response("healthy\n", { headers: { "Content-Type": "text/plain" } });
  }

  // robots.txt — also serve at root for convenience.
  if (method === "GET" && pathname === "/robots.txt") {
    const file = Bun.file("./src/static/robots.txt");
    if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/plain" } });
  }

  // Static files
  if (method === "GET") {
    const staticRes = await serveStatic(pathname);
    if (staticRes) return staticRes;
  }

  // Only GET and POST are routed.
  if (method !== "GET" && method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }

  // Look up route.
  let matched: { def: RouteDef; m: RegExpMatchArray } | null = null;
  for (const def of ROUTES) {
    if (def.method !== method) continue;
    const m = pathname.match(def.pattern);
    if (m) {
      matched = { def, m };
      break;
    }
  }

  // Load admin session for every request (cheap; one indexed lookup at most).
  // If the cookie isn't present, this returns null quickly without hitting the DB.
  const admin = await getSessionFromRequest(req).catch(() => null);

  if (!matched) {
    // 404 — try to render a styled page via the layout module.
    const { h } = await import("./html.ts");
    const { layout } = await import("./layout.ts");
    const { htmlResponse } = await import("./routes/types.ts");
    const body = h`<p>The page you requested does not exist.</p>
      <p><a href="/">Home</a> · <a href="/browse">Browse</a></p>`;
    return htmlResponse(
      layout({ title: "Not found · EAH", heading: "Not found", body, admin }),
      { status: 404 },
    );
  }

  // Build params.
  const params: Record<string, string> = {};
  for (let i = 0; i < matched.def.paramKeys.length; i++) {
    const key = matched.def.paramKeys[i]!;
    const raw = matched.m[i + 1] ?? "";
    try {
      params[key] = decodeURIComponent(raw);
    } catch {
      params[key] = raw;
    }
  }

  const ctx: RouteContext = {
    params,
    url,
    ip: clientIp(req, server),
    admin,
  };

  try {
    return await matched.def.handler(req, ctx);
  } catch (err) {
    console.error(`[${method} ${pathname}] handler error:`, err);
    const { h } = await import("./html.ts");
    const { layout } = await import("./layout.ts");
    const { htmlResponse } = await import("./routes/types.ts");
    const body = h`<p>Something went wrong on our end. Please try again later.</p>`;
    return htmlResponse(
      layout({ title: "Server error · EAH", heading: "Server error", body, admin }),
      { status: 500 },
    );
  }
}

const server = Bun.serve({
  port: config.port,
  // Bind to 0.0.0.0 so the container is reachable on the published port.
  hostname: "0.0.0.0",
  async fetch(req) {
    const res = await handle(req, server);
    return addSecurityHeaders(res);
  },
  error(err) {
    console.error("Server-level error:", err);
    return new Response("Internal Server Error\n", { status: 500 });
  },
});

console.log(`EAH listening on http://${server.hostname}:${server.port}`);

// Periodic GC for in-memory rate-limit buckets and expired sessions.
setInterval(() => {
  ratelimitGc();
  void purgeExpiredSessions();
}, 10 * 60 * 1000).unref?.();
