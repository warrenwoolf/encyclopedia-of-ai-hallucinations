/**
 * RSS 2.0 feed — 20 most recently published entries.
 *
 *   GET /rss
 *
 * XML is built by hand (not via h``) because RSS is not HTML and the
 * `h`` escaper targets HTML attribute/text contexts.  We use a local
 * xmlEscape() that covers the five XML special characters.
 */
import { query } from "../db.ts";
import { config } from "../config.ts";
import { formatEahId } from "../eah-id.ts";
import type { RouteHandler } from "./types.ts";

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** RFC 822 date (e.g. "Thu, 21 May 2026 12:34:56 +0000"). */
function toRfc822(d: Date | string | null): string {
  if (!d) return new Date(0).toUTCString();
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toUTCString();
}

interface Row {
  eah_number: number | null;
  public_id: string;
  title: string | null;
  summary: string | null;
  prompt: string;
  ai_model: string | null;
  submitted_at: Date | string | null;
  reviewed_at: Date | string | null;
}

export const rss: RouteHandler = async () => {
  const rows = await query<Row>(
    `SELECT eah_number, public_id, title, summary, prompt, ai_model, submitted_at, reviewed_at
       FROM submissions
      WHERE status = 'published'
      ORDER BY COALESCE(reviewed_at, submitted_at) DESC
      LIMIT 20`,
  );

  const base = config.publicBaseUrl;

  const items = rows.map((row) => {
    const eahId = formatEahId(row.eah_number);
    const link = `${base}/e/${xmlEscape(eahId)}`;
    const title = xmlEscape(`${eahId} — ${row.title ?? "(no title)"}`);

    // Use summary when available; otherwise truncate the prompt to 300 chars.
    const descRaw = row.summary && row.summary.trim().length > 0
      ? row.summary.trim()
      : row.prompt.trim().slice(0, 300);
    const description = xmlEscape(descRaw);

    const pubDate = toRfc822(row.reviewed_at ?? row.submitted_at);

    return `    <item>
      <title>${title}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <description>${description}</description>
      <pubDate>${pubDate}</pubDate>
    </item>`;
  }).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Encyclopedia of AI Hallucinations</title>
    <link>${xmlEscape(base)}/</link>
    <description>Recently published hallucination entries.</description>
    <atom:link href="${xmlEscape(base)}/rss" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
};
