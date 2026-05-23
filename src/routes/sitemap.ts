/**
 * Sitemap (sitemap.xml) for published entries.
 *
 *   GET /sitemap.xml
 *
 * The sitemap is cached in memory for 1 hour.  This is intentional: sitemap
 * generation does a full table scan of published entries and should not run on
 * every crawler request.  A 1-hour lag on new entries is fine.
 *
 * XML is built by hand (not via h``) — see rss.ts for reasoning.
 */
import { query } from "../db.ts";
import { config } from "../config.ts";
import { formatEahId } from "../eah-id.ts";
import type { RouteHandler } from "./types.ts";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cached: string | null = null;
let cacheTime = 0;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toW3CDate(d: Date | string | null): string {
  if (!d) return "1970-01-01";
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

interface Row {
  eah_number: number;
  lastmod: Date | string | null;
}

async function buildSitemap(): Promise<string> {
  const base = config.publicBaseUrl;

  const staticPages = [
    { loc: `${base}/`, changefreq: "weekly" },
    { loc: `${base}/browse`, changefreq: "monthly" },
    { loc: `${base}/about`, changefreq: "monthly" },
    { loc: `${base}/privacy`, changefreq: "monthly" },
  ];

  const staticUrls = staticPages.map(({ loc, changefreq }) =>
    `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <changefreq>${changefreq}</changefreq>\n  </url>`
  ).join("\n");

  const rows = await query<Row>(
    `SELECT eah_number, COALESCE(reviewed_at, submitted_at) AS lastmod
       FROM submissions
      WHERE status = 'published'
        AND eah_number IS NOT NULL
      ORDER BY eah_number ASC`,
  );

  const entryUrls = rows.map((row) => {
    const eahId = formatEahId(row.eah_number);
    const loc = xmlEscape(`${base}/e/${eahId}`);
    const lastmod = toW3CDate(row.lastmod);
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n  </url>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls}
${entryUrls}
</urlset>`;
}

export const sitemap: RouteHandler = async () => {
  const now = Date.now();
  if (cached === null || now - cacheTime > CACHE_TTL_MS) {
    cached = await buildSitemap();
    cacheTime = now;
  }

  return new Response(cached, {
    status: 200,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
