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
import { primeQuotaCache } from "./email.ts";
import { loadCategories } from "./categories.ts";
import { startDiscordPresence } from "./discord-gateway.ts";
import type { RouteContext, RouteHandler } from "./routes/types.ts";

import { home } from "./routes/home.ts";
import { entry } from "./routes/entry.ts";
import { postComplaint } from "./routes/complaint.ts";
import { getComplaints } from "./routes/admin/complaints.ts";
import { browse } from "./routes/browse.ts";
import { submitGet, submitPost } from "./routes/submit.ts";
import { about } from "./routes/about.ts";
import { guide } from "./routes/guide.ts";
import { terms } from "./routes/terms.ts";
import { privacy } from "./routes/privacy.ts";
import { getLogin, postLogin, postLogout } from "./routes/login.ts";
import { getSignup, postSignup } from "./routes/signup.ts";
import { getVerify, postVerify, postVerifyResend } from "./routes/verify.ts";
import { postGisVerify, getChooseUsername, postChooseUsername } from "./routes/oauth-google-routes.ts";
import { getQueue, getQueueDetail } from "./routes/admin/queue.ts";
import { postReview, postReviewMessage } from "./routes/admin/review.ts";
import {
  getNewEntry, postNewEntry, getEditEntry, postEditEntry, getQueueEdit, postQueueEdit,
  postEntryStatus, redirectToEntry,
} from "./routes/admin/entries.ts";
import { getAll, getDeleteConfirm, postDelete } from "./routes/admin/all.ts";
import { getCategories, postCategory, getDeleteCategory, postDeleteCategory } from "./routes/admin/categories.ts";
import { getUsers, getStaff, postUserAction } from "./routes/admin/users.ts";
import {
  mySubmissions, myView, myEditGet, myEditPost, myPropose,
  myWithdrawConfirm, myWithdraw, myDeleteConfirm, myDelete, myHistory,
} from "./routes/my.ts";
import { myDiscussionGet, myDiscussionPost } from "./routes/my-discussion.ts";
import { usernameCheck } from "./routes/api.ts";
import { rss } from "./routes/rss.ts";
import { sitemap } from "./routes/sitemap.ts";

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
  route("GET", "/guide", guide),
  route("GET", "/terms", terms),
  route("GET", "/privacy", privacy),
  route("GET", "/browse", browse),
  route("GET", "/e/:public_id", entry),
  route("POST", "/e/:public_id/complaint", postComplaint),
  route("GET", "/submit", submitGet),
  route("POST", "/submit", submitPost),
  // Accounts (users + admins use the same login surface)
  route("GET", "/login", getLogin),
  route("POST", "/login", postLogin),
  route("POST", "/logout", postLogout),
  route("GET", "/signup", getSignup),
  route("POST", "/signup", postSignup),
  route("GET", "/verify", getVerify),
  route("POST", "/verify", postVerify),
  route("POST", "/verify/resend", postVerifyResend),
  route("POST", "/oauth/google/verify", postGisVerify),
  // New Google accounts pick a username before the account is created.
  route("GET", "/choose-username", getChooseUsername),
  route("POST", "/choose-username", postChooseUsername),
  // User draft dashboard. The :eahId segment is always in A-number format so it
  // never collides with literal path segments like "new" used in admin routes.
  route("GET",  "/my/submissions",                    mySubmissions),
  route("GET",  "/my/submissions/:eahId/edit",        myEditGet),
  route("POST", "/my/submissions/:eahId/edit",        myEditPost),
  route("POST", "/my/submissions/:eahId/propose",     myPropose),
  // withdraw (pending→draft) and delete (draft→gone) each have a GET confirm
  // page and a POST that performs the action.
  route("GET",  "/my/submissions/:eahId/withdraw",    myWithdrawConfirm),
  route("POST", "/my/submissions/:eahId/withdraw",    myWithdraw),
  route("GET",  "/my/submissions/:eahId/delete",      myDeleteConfirm),
  route("POST", "/my/submissions/:eahId/delete",      myDelete),
  route("GET",  "/my/submissions/:eahId/history",     myHistory),
  route("GET",  "/my/submissions/:eahId/discussion",  myDiscussionGet),
  route("POST", "/my/submissions/:eahId/message",     myDiscussionPost),
  // Overview page — single read-only view of a submission. Registered last so
  // its single-segment :eahId pattern can't shadow the more specific routes
  // above (the regex is anchored per-segment anyway).
  route("GET",  "/my/submissions/:eahId",             myView),
  // API endpoints
  route("GET",  "/api/username-check",  usernameCheck),
  // Feeds / discovery
  route("GET",  "/rss",                 rss),
  route("GET",  "/sitemap.xml",         sitemap),
  route("GET", "/admin/queue", getQueue),
  route("GET", "/admin/queue/:id", getQueueDetail),
  route("POST", "/admin/queue/:id", postReview),
  route("GET", "/admin/queue/:id/edit", getQueueEdit),
  route("POST", "/admin/queue/:id/edit", postQueueEdit),
  route("POST", "/admin/queue/:id/message", postReviewMessage),
  route("GET", "/admin/all", getAll),
  // Read-only list of open entry complaints (staff + owner).
  route("GET", "/admin/complaints", getComplaints),
  // Staff-managed category list (add new categories at runtime).
  route("GET", "/admin/categories", getCategories),
  route("POST", "/admin/categories", postCategory),
  route("GET", "/admin/categories/:key/delete", getDeleteCategory),
  route("POST", "/admin/categories/:key/delete", postDeleteCategory),
  // Owner-only permanent delete of an entry from the all-submissions view.
  // Two-step: GET confirms, POST deletes.
  route("GET", "/admin/all/:id/delete", getDeleteConfirm),
  route("POST", "/admin/all/:id/delete", postDelete),
  // Account management (users + staff roster). One POST endpoint dispatches on
  // the `action` field: promote/demote/suspend/unsuspend/delete.
  route("GET", "/admin/users", getUsers),
  route("GET", "/admin/staff", getStaff),
  route("POST", "/admin/users/:id", postUserAction),
  // Direct add/edit of entries (bypasses the draft workflow). The path is
  // /admin/entries/new and /admin/entries/:eahId/edit so it's clear these are
  // admin-only actions, even though the public entry URL is /e/A000001.
  route("GET", "/admin/entries/new", getNewEntry),
  route("POST", "/admin/entries/new", postNewEntry),
  route("GET", "/admin/entries/:eahId/edit", getEditEntry),
  route("POST", "/admin/entries/:eahId/edit", postEditEntry),
  route("POST", "/admin/entries/:eahId/status", postEntryStatus),
  // Jump-to-entry helper used by the admin jump-to form.
  route("GET", "/admin/entries/redirect", redirectToEntry),
];

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; style-src-elem 'self' 'unsafe-inline' https://accounts.google.com https://www.gstatic.com; style-src-attr 'unsafe-inline'; script-src 'self' https://accounts.google.com https://static.cloudflareinsights.com; connect-src 'self' https://accounts.google.com https://cloudflareinsights.com; frame-src 'self' https://accounts.google.com https://www.gstatic.com; object-src 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'",
  "Permissions-Policy": "interest-cohort=()",
};

function addSecurityHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  return res;
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function clientIp(req: Request, server: { requestIP?: (req: Request) => { address: string } | null }): string {
  // Behind cloudflared, Cloudflare sets cf-connecting-ip with the real client IP.
  // Trust it ONLY if the immediate TCP peer is loopback — i.e. cloudflared on
  // the host. Otherwise an attacker hitting :8090 directly could spoof the
  // header to bypass rate limits or poison ip_hash. We additionally publish
  // the port on 127.0.0.1 only (see docker-compose.yml).
  let peer: string | undefined;
  try {
    peer = server.requestIP?.(req)?.address;
  } catch {}

  if (isLoopback(peer)) {
    const cf = req.headers.get("cf-connecting-ip");
    if (cf && /^[A-Za-z0-9.:_-]{1,64}$/.test(cf.trim())) return cf.trim();
  }
  // Do NOT honor X-Forwarded-For — cloudflared uses cf-connecting-ip, and XFF
  // is too easy to spoof from anywhere on the host network.
  return peer ?? "0.0.0.0";
}

// Explicit allowlist — there are only a couple of static files. Easier to audit
// than a regex, and we never accidentally let `..` or `.` through.
const STATIC_FILES: Record<string, { path: string; contentType: string }> = {
  "style.css": { path: "./src/static/style.css", contentType: "text/css; charset=utf-8" },
  "theme.js": { path: "./src/static/theme.js", contentType: "application/javascript; charset=utf-8" },
  "browse.js": { path: "./src/static/browse.js", contentType: "application/javascript; charset=utf-8" },
  "turns.js": { path: "./src/static/turns.js", contentType: "application/javascript; charset=utf-8" },
  "google.js": { path: "./src/static/google.js", contentType: "application/javascript; charset=utf-8" },
  "robots.txt": { path: "./src/static/robots.txt", contentType: "text/plain; charset=utf-8" },
};

async function serveStatic(pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/static/")) return null;
  const rest = pathname.slice("/static/".length);
  const entry = STATIC_FILES[rest];
  if (!entry) return null;
  const file = Bun.file(entry.path);
  if (!(await file.exists())) return null;
  return new Response(file, {
    headers: {
      "Content-Type": entry.contentType,
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

  // favicon.ico — serve the site logo SVG so browsers have a stable icon URL.
  if (method === "GET" && pathname === "/favicon.ico") {
    const file = Bun.file("./src/static/logo.svg");
    if (await file.exists()) {
      return new Response(file, { headers: { "Content-Type": "image/svg+xml" } });
    }
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

  // Load user session for every request (cheap; one indexed lookup at most).
  // If the cookie isn't present, this returns null quickly without hitting the DB.
  const user = await getSessionFromRequest(req).catch(() => null);
  // `admin` is the same session, but only set when the user is an admin —
  // lets admin route handlers keep their `if (!ctx.admin) return authRedirect()`
  // gating pattern without an isAdmin check at every site. Owners are admins.
  const admin = user && user.isAdmin ? user : null;
  // `owner` is only set for owners — account-management mutations gate on it.
  const owner = user && user.isOwner ? user : null;

  if (!matched) {
    // 404 — try to render a styled page via the layout module.
    const { h, raw } = await import("./html.ts");
    const { layout } = await import("./layout.ts");
    const { htmlResponse } = await import("./routes/types.ts");
    const { query } = await import("./db.ts");
    const { formatEahId } = await import("./eah-id.ts");
    let suggestions: Array<{ eah_number: number | null; title: string | null; public_id: string }> = [];
    try {
      suggestions = await query("SELECT eah_number, title, public_id FROM submissions WHERE status='reviewed' AND repro_status='reproduced' ORDER BY RAND() LIMIT 3");
    } catch {}
    const suggestionList = suggestions.length === 0
      ? raw("")
      : h`<p>Or try one of these:</p><ul>${suggestions.map(s => {
          const eahId = formatEahId(s.eah_number);
          const url = eahId ? `/e/${eahId}` : `/e/${s.public_id}`;
          const label = eahId ? `${eahId}${s.title ? ` — ${s.title}` : ""}` : (s.title ?? s.public_id);
          return h`<li><a href="${url}">${label}</a></li>`;
        })}</ul>`;
    const body = h`
      <p>The page you requested does not exist.</p>
      <form method="get" action="/browse">
        <input type="search" name="q" placeholder="Search entries" autofocus>
        <button type="submit">Search</button>
      </form>
      ${suggestionList}
      <p><a href="/">Home</a> · <a href="/browse">Browse</a></p>
    `;
    return htmlResponse(
      await layout({ title: "Not found · ENAIH", heading: "Not found", body, user }),
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
    user,
    admin,
    owner,
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
      await layout({ title: "Server error · ENAIH", heading: "Server error", body, user }),
      { status: 500 },
    );
  }
}

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
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

// Best-effort probe of Resend's `x-resend-monthly-quota` header on cold start
// so the signup form knows whether we're at cap before any send happens. Fire
// and forget; a failure here just leaves the cache empty (fail-open).
void primeQuotaCache().catch(e => console.warn("[startup] primeQuotaCache failed:", e));

// Load the category set from the DB into the in-memory cache. Until this
// resolves, src/categories.ts serves the built-in defaults.
void loadCategories().catch(e => console.warn("[startup] loadCategories failed:", e));

// Open a Discord gateway connection so the bot shows as "online" while the site
// is running (the REST notifier in discord.ts alone leaves it offline). No-ops
// when DISCORD_BOT_TOKEN is unset; never throws.
startDiscordPresence();

// Periodic GC for in-memory rate-limit buckets and expired sessions.
setInterval(() => {
  ratelimitGc();
  void purgeExpiredSessions();
}, 10 * 60 * 1000).unref?.();
