/**
 * POST /e/:id/complaint — a visitor reports a problem with a published entry.
 *
 * Public + anonymous-friendly: entry pages are public, so the reporter may be
 * logged out (reporter_user_id NULL in that case). The complaint is
 *   (a) logged in the `complaints` table,
 *   (b) emailed to the staff contact inbox (sendComplaint), and
 *   (c) posted to the staff Discord channel (notifyComplaint),
 * the latter two fire-and-forget so a slow/failed side channel can't block the
 * redirect back to the entry.
 *
 * The matching <details> form lives at the end of the entry body in entry.ts;
 * on success we redirect back to /e/:id?complaint=ok and the entry page shows a
 * small "thanks" notice.
 */
import { createHash } from "node:crypto";
import { queryOne, execute } from "../db.ts";
import { config } from "../config.ts";
import { pageResponse } from "../layout.ts";
import { h } from "../html.ts";
import { formatEahId, parseEahId } from "../eah-id.ts";
import { verifyCsrf } from "../csrf.ts";
import { check as rateCheck } from "../ratelimit.ts";
import { sendComplaint } from "../email.ts";
import { notifyComplaint } from "../discord.ts";
import { parseForm, sanitizeText, type RouteHandler } from "./types.ts";

/**
 * Hardcoded complaint categories. These are NOT the hallucination categories —
 * they describe what's wrong with the *entry* itself. The key is stored in
 * `complaints.complaint_type`; the label is shown in the form, email, and
 * Discord notice.
 */
export const COMPLAINT_TYPES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "factual", label: "Factual error in this entry" },
  { key: "miscategorized", label: "Wrong category" },
  { key: "duplicate", label: "Duplicate of another entry" },
  { key: "inappropriate", label: "Inappropriate / abusive content" },
  { key: "broken", label: "Broken link or formatting" },
  { key: "other", label: "Other" },
];

const TYPE_LABELS = new Map(COMPLAINT_TYPES.map((t) => [t.key, t.label]));

const MAX_BODY = 2000;

interface MatchedRow {
  id: number;
  eah_number: number | null;
  status: string;
}

/** Resolve a published submission by A-number or legacy public_id slug. */
async function findPublished(idParam: string): Promise<MatchedRow | null> {
  const eahNum = parseEahId(idParam);
  const row = eahNum !== null
    ? await queryOne<MatchedRow>(
        "SELECT id, eah_number, status FROM submissions WHERE eah_number = ?",
        [eahNum],
      )
    : await queryOne<MatchedRow>(
        "SELECT id, eah_number, status FROM submissions WHERE public_id = ?",
        [idParam],
      );
  if (!row || row.status !== "published" || row.eah_number === null) return null;
  return row;
}

function backLink(eahId: string): string {
  return `/e/${eahId}`;
}

export const postComplaint: RouteHandler = async (req, ctx) => {
  const idParam = ctx.params.public_id;
  if (!idParam || !/^[A-Za-z0-9_-]{1,32}$/.test(idParam)) {
    return new Response(null, { status: 303, headers: { Location: "/browse" } });
  }

  // Rate-limit first; anonymous visitors can hit this and each one writes a row
  // and fires two outbound side channels.
  const rl = rateCheck("complaint", ctx.ip);
  if (!rl.allowed) {
    const body = h`<p>Too many reports from your connection. Please retry in ${rl.retryAfterSec ?? 60} seconds.</p>`;
    return pageResponse(
      req,
      { title: "Rate limited · EAH", heading: "Slow down", body, user: ctx.user },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } },
    );
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 16 * 1024);
  } catch {
    const body = h`<p>That report was too large.</p>`;
    return pageResponse(
      req,
      { title: "Too large · EAH", heading: "Too large", body, user: ctx.user },
      { status: 413 },
    );
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    const body = h`<p>Invalid CSRF token. Reload the entry page and try again.</p>`;
    return pageResponse(
      req,
      { title: "Forbidden · EAH", heading: "Forbidden", body, user: ctx.user },
      { status: 403 },
    );
  }

  const row = await findPublished(idParam);
  if (!row) {
    const body = h`<p>No published entry with that ID.</p>`;
    return pageResponse(
      req,
      { title: "Not found · EAH", heading: "Not found", body, user: ctx.user },
      { status: 404 },
    );
  }
  const eahId = formatEahId(row.eah_number);

  const complaintType = (form.get("complaint_type") ?? "").trim();
  const noteRaw = sanitizeText(form.get("body") ?? "").trim();

  // Validate: known type + non-empty, length-capped note.
  const label = TYPE_LABELS.get(complaintType);
  if (!label || noteRaw.length === 0 || noteRaw.length > MAX_BODY) {
    const body = h`
      <p>Your report couldn't be submitted. Please pick a category and write a
      short note (up to ${MAX_BODY} characters).</p>
      <p><a href="${backLink(eahId)}">Back to ${eahId}</a></p>`;
    return pageResponse(
      req,
      { title: "Report not sent · EAH", heading: "Report not sent", body, user: ctx.user },
      { status: 400 },
    );
  }

  const reporterUserId = ctx.user ? ctx.user.userId : null;
  const ipHash = createHash("sha256")
    .update(`${config.sessionSecret}:${ctx.ip}`)
    .digest();

  await execute(
    `INSERT INTO complaints
       (submission_id, reporter_user_id, complaint_type, body, status, ip_hash)
     VALUES (?, ?, ?, ?, 'open', ?)`,
    [row.id, reporterUserId, complaintType, noteRaw, ipHash],
  );

  // Notify staff out-of-band. Fire-and-forget: a slow/failed email or Discord
  // post must not block the redirect (both modules never throw, but the void
  // also drops the returned promise so we don't await it).
  const reporter = ctx.user ? `user:${ctx.user.username}` : "anonymous";
  void sendComplaint({ eahId, complaintLabel: label, body: noteRaw, reporter });
  void notifyComplaint({ eahId, complaintLabel: label, body: noteRaw, reporter });

  return new Response(null, {
    status: 303,
    headers: { Location: `${backLink(eahId)}?complaint=ok` },
  });
};
