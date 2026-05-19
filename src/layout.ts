/** Base HTML layout. */
import { h, raw, renderToString, SafeHtml } from "./html.ts";
import { config } from "./config.ts";

export interface LayoutOptions {
  title: string;
  body: SafeHtml;
  /** If set, shown as an h1 above the body. */
  heading?: string;
  /** Show admin nav (only if logged-in admin context). */
  admin?: { username: string } | null;
  /** Optional sub-nav links above the body. */
  subnav?: SafeHtml | null;
}

export function layout(opts: LayoutOptions): string {
  const banner = config.inDevelopment
    ? h`<div class="banner">
        <strong>IN DEVELOPMENT</strong> — this site is being built. Submissions may be deleted, the schema may change,
        and nothing here is final.
      </div>`
    : raw("");

  const adminNav = opts.admin
    ? h`<span class="admin-nav">
        signed in as <strong>${opts.admin.username}</strong> ·
        <a href="/admin/queue">queue</a> ·
        <a href="/admin/all">all</a> ·
        <form method="post" action="/admin/logout" style="display:inline">
          <button class="linkbutton" type="submit">log out</button>
        </form>
      </span>`
    : raw("");

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
  </head>
  <body>
    ${banner}
    <header>
      <a class="site-title" href="/">Encyclopedia of AI Hallucinations</a>
      <nav>
        <a href="/browse">browse</a>
        <a href="/submit">submit</a>
        <a href="/track">track</a>
        <a href="/about">about</a>
        ${adminNav}
      </nav>
    </header>
    <main>
      ${heading}
      ${subnav}
      ${opts.body}
    </main>
    <footer>
      <p>Encyclopedia of AI Hallucinations. No accounts, no tracking, no ads.</p>
    </footer>
  </body>
</html>`;

  return renderToString(page);
}
