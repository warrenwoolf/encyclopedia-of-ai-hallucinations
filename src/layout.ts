/** Base HTML layout. */
import { h, raw, renderToString, SafeHtml } from "./html.ts";
import { config } from "./config.ts";
import type { UserSession } from "./auth.ts";
import { tokenForRequest } from "./csrf.ts";
import { htmlResponse } from "./routes/types.ts";

// Inlined so it inherits `currentColor` from .site-title (works in dark mode).
const STRAWBERRY_SVG = raw(await Bun.file("./src/static/logo.svg").text());

export interface LayoutOptions {
  title: string;
  body: SafeHtml;
  /** If set, shown as an h1 above the body. */
  heading?: string;
  /**
   * Signed-in user (admin or not). The user-nav block shows either
   * "log in · sign up" (when null) or "signed in as X · [admin links if
   * isAdmin] · log out" (otherwise). A vertical separator bar is always
   * present so the layout doesn't jump when state changes.
   *
   * `csrfToken` is used by the logout form so the POST passes verification.
   * If omitted, logout still renders but will be 403'd by the handler.
   */
  user?: UserSession | null;
  csrfToken?: string;
  /** Optional sub-nav links above the body. */
  subnav?: SafeHtml | null;
}

/**
 * Convenience wrapper that combines layout + tokenForRequest + htmlResponse.
 *
 * Use this from routes that don't otherwise need to manage the CSRF cookie
 * themselves. It guarantees the logout form in the nav has a valid CSRF
 * token even on pages whose own bodies don't render any forms.
 *
 * Routes that DO render their own forms typically call tokenForRequest +
 * htmlResponse explicitly and pass `csrfToken` into `layout()`; those keep
 * working unchanged.
 */
export function pageResponse(
  req: Request,
  opts: Omit<LayoutOptions, "csrfToken">,
  init?: { status?: number; headers?: Record<string, string>; setCookie?: string | null },
): Response {
  const { token, setCookie } = tokenForRequest(req);
  const html = layout({ ...opts, csrfToken: token });
  return htmlResponse(html, {
    status: init?.status,
    headers: init?.headers,
    // Caller-supplied setCookie wins (e.g. a session cookie being set on
    // the same response); fall back to the CSRF cookie if we minted one.
    setCookie: init?.setCookie ?? setCookie,
  });
}

export function layout(opts: LayoutOptions): string {
  const banner = config.inDevelopment
    ? h`<div class="banner">
        <strong>IN DEVELOPMENT</strong> — this site is being built. Submissions may be deleted, the schema may change,
        and nothing here is final.
      </div>`
    : raw("");

  // User nav: always rendered (so the separator bar is always visible).
  // - logged out → "log in · sign up"
  // - logged in → "signed in as X · [admin links] · log out"
  const csrfToken = opts.csrfToken ?? "";
  let userNav: SafeHtml;
  if (opts.user) {
    const adminLinks = opts.user.isAdmin
      ? h`<a href="/admin/queue">queue</a> ·
          <a href="/admin/all">all</a> ·`
      : raw("");
    userNav = h`<span class="user-nav">
        signed in as <strong>${opts.user.username}</strong> ·
        ${adminLinks}
        <form class="inline-form" method="post" action="/logout">
          <input type="hidden" name="_csrf" value="${csrfToken}">
          <button class="linkbutton" type="submit">log out</button>
        </form>
      </span>`;
  } else {
    userNav = h`<span class="user-nav">
        <a href="/login">log in</a> ·
        <a href="/signup">sign up</a>
      </span>`;
  }

  const heading = opts.heading
    ? h`<h1>${opts.heading}</h1>`
    : raw("");

  const subnav = opts.subnav ?? raw("");

  const page = h`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>${opts.title}</title>
    <link rel="stylesheet" href="/static/style.css">
    <script src="/static/theme.js"></script>
  </head>
  <body>
    ${banner}
    <header>
      <a class="site-title" href="/">
        <span class="site-logo-block">
          ${STRAWBERRY_SVG}
          <span class="site-logo-caption">EAH</span>
        </span>
        <span class="site-title-text">Encyclopedia of AI Hallucinations</span>
      </a>
      <p class="site-credit">Founded by Rudra Jadhav and Warren Woolf</p>
      <nav>
        <a href="/browse">browse</a>
        <a href="/submit">submit</a>
        <a href="/track">track</a>
        <a href="/lookup">lookup</a>
        <a href="/about">about</a>
        <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle theme">
          <span class="theme-icon">◐</span><span class="theme-label">theme</span>
        </button>
        ${userNav}
      </nav>
    </header>
    <main>
      ${heading}
      ${subnav}
      ${opts.body}
    </main>
    <footer>
      <p><a href="/about">about</a> · <a href="/privacy">privacy</a></p>
      <p class="muted">Founded in 2026 by Rudra Jadhav and Warren Woolf.</p>
    </footer>
  </body>
</html>`;

  return renderToString(page);
}
