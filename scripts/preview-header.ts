/**
 * Throwaway preview server for header/layout work. Renders the real layout
 * with a stub body — no DB, no auth, no env beyond the bare minimum.
 *
 * Usage:  DB_USER=x DB_PASSWORD=x DB_NAME=x SESSION_SECRET=$(openssl rand -hex 32) \
 *           bun scripts/preview-header.ts
 */
import { layout } from "../src/layout.ts";
import { h, raw } from "../src/html.ts";

const body = h`
  <div class="home-top">
    <p>A catalog of LLM hallucinations. There are currently <strong>0</strong> published entries.</p>
    <form action="/browse" method="get" class="search-form">
      <input type="search" name="q" placeholder="search prompts, outputs, models...">
      <button type="submit">Search</button>
    </form>
    <p><a class="cta" href="/submit">Submit a hallucination</a></p>
    <nav class="category-nav">
      <strong>Categories:</strong>
      <a href="#">counting</a>, <a href="#">attribution</a>, <a href="#">code</a>, <a href="#">citation</a>
    </nav>
    <h2>Recently published</h2>
  </div>
  <p><em>(preview stub — no DB)</em></p>
`;

Bun.serve({
  port: 8091,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/static/style.css") {
      return new Response(Bun.file("./src/static/style.css"), {
        headers: { "Content-Type": "text/css" },
      });
    }
    const html = await layout({
      title: "Encyclopedia of AI Hallucinations",
      body,
      user: null,
    });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
});

console.log("preview at http://127.0.0.1:8091/");
