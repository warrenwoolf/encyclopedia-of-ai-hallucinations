/**
 * Admin review action.
 *
 *   POST /admin/queue/:id   — approve or reject a submission
 *
 * On reject (and withdraw, handled elsewhere) the submission's EAH number is
 * returned to the freed-numbers pool so the next incoming draft can claim it.
 * On approve, the number is locked permanently.
 */
import { h } from "../../html.ts";
import { layout } from "../../layout.ts";
import { execute, transaction, queryOne } from "../../db.ts";
import { verifyCsrf } from "../../csrf.ts";
import { sendDecision, sendReviewerMessage } from "../../email.ts";
import { freeEahNumber, formatEahId } from "../../eah-id.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteContext } from "../types.ts";

function badRequest(message: string, status = 400, returnTo?: string): Response {
  const link = returnTo
    ? h` <a href="${returnTo}">Return to the queue</a>.`
    : h` <a href="/admin/queue">Return to the queue</a>.`;
  const body = layout({
    title: "Bad request",
    heading: "Bad request",
    body: h`<p>${message}${link}</p>`,
  });
  return htmlResponse(body, { status });
}

function csrfErrorResponse(): Response {
  const body = layout({
    title: "Invalid CSRF token",
    heading: "Invalid CSRF token",
    body: h`<p>Your form submission could not be verified. Please go back and try again.</p>`,
  });
  return htmlResponse(body, { status: 403 });
}

/**
 * Parses an optional bounded integer field.
 *   - empty / missing → null
 *   - non-numeric or out of [0,999] → throws
 */
function parseBoundedInt(raw: string | null, name: string): number | null {
  if (raw === null) return null;
  const v = raw.trim();
  if (v === "") return null;
  if (!/^\d{1,3}$/.test(v)) throw new Error(`${name} must be a whole number 0–999`);
  const n = parseInt(v, 10);
  if (n < 0 || n > 999) throw new Error(`${name} must be 0–999`);
  return n;
}

/** Sanitize, trim, null-ify empty text, enforce max length. */
function parseText(raw: string | null, name: string, max: number): string | null {
  if (raw === null) return null;
  const v = sanitizeText(raw).trim();
  if (v === "") return null;
  if (v.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return v;
}

export async function postReview(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) {
    return new Response(null, { status: 303, headers: { Location: "/admin/login" } });
  }

  const idStr = ctx.params.id;
  const id = idStr && /^\d+$/.test(idStr) ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id) || id <= 0) {
    return badRequest("Invalid submission id.", 404);
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req);
  } catch {
    return badRequest("The form submission was too large or malformed.");
  }

  if (!verifyCsrf(req, form.get("_csrf"))) return csrfErrorResponse();

  const action = form.get("action");
  if (action !== "approve" && action !== "reject") {
    return badRequest("Unknown review action.");
  }

  let verifiedHits: number | null;
  let verifiedTotal: number | null;
  let reviewerNotes: string | null;
  let rejectionReason: string | null;
  let staffReviewMessage: string | null;
  try {
    verifiedHits = parseBoundedInt(form.get("verified_hits"), "verified_hits");
    verifiedTotal = parseBoundedInt(form.get("verified_total"), "verified_total");
    reviewerNotes = parseText(form.get("reviewer_notes"), "reviewer_notes", 4000);
    rejectionReason = parseText(form.get("rejection_reason"), "rejection_reason", 1000);
    staffReviewMessage = parseText(form.get("staff_review_message"), "staff_review_message", 4000);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Invalid form input.");
  }

  // Sanity: total must be >= hits when both supplied.
  if (verifiedHits !== null && verifiedTotal !== null && verifiedTotal < verifiedHits) {
    return badRequest("verified_total must be greater than or equal to verified_hits.");
  }
  // If only hits is supplied without total, that's nonsensical — reject.
  if (verifiedHits !== null && verifiedTotal === null) {
    return badRequest("Provide verified_total if verified_hits is set.");
  }

  // Confirm the submission exists before update so we can return a proper 404.
  // Also pull the fields we'll need to compose the outbound email so we can
  // skip the email entirely when there's no submitter_email or notify_token.
  const exists = await queryOne<{
    id: number;
    public_id: string;
    eah_number: number | null;
    ai_model: string | null;
    submitter_email: string | null;
    notify_token: string | null;
  }>(
    "SELECT id, public_id, eah_number, ai_model, submitter_email, notify_token FROM submissions WHERE id = ?",
    [id],
  );
  if (!exists) return badRequest("Submission not found.", 404);

  // The approve/reject + (optional) free-number step must be atomic: if we
  // freed before the status flip and then the status flip failed, we'd hand
  // a still-pending submission's number to the next draft. Wrap in a single
  // transaction.
  try {
    await transaction(async (tx) => {
      if (action === "approve") {
        await tx.execute(
          `UPDATE submissions
              SET status = 'published',
                  reviewed_by = ?,
                  reviewed_at = NOW(),
                  verified_hits = ?,
                  verified_total = ?,
                  reviewer_notes = ?,
                  staff_review_message = ?,
                  rejection_reason = NULL
            WHERE id = ?`,
          [ctx.admin!.adminId, verifiedHits, verifiedTotal, reviewerNotes, staffReviewMessage, id],
        );
        // Post a 'system' message into the chat thread so the submitter sees
        // the decision in-place.
        await tx.execute(
          `INSERT INTO submission_messages (submission_id, sender_type, body)
           VALUES (?, 'system', ?)`,
          [id, `Submission approved and published${staffReviewMessage ? ` with a note from the reviewer (see below).` : `.`}`],
        );
      } else {
        await tx.execute(
          `UPDATE submissions
              SET status = 'rejected',
                  reviewed_by = ?,
                  reviewed_at = NOW(),
                  rejection_reason = ?,
                  reviewer_notes = ?,
                  staff_review_message = ?,
                  verified_hits = ?,
                  verified_total = ?
            WHERE id = ?`,
          [ctx.admin!.adminId, rejectionReason, reviewerNotes, staffReviewMessage, verifiedHits, verifiedTotal, id],
        );
        // OEIS rule: a rejected draft's A-number returns to the pool. Do this
        // here, inside the same transaction, so we never expose a "rejected
        // with live A-number" state to readers.
        await freeEahNumber(tx, id);
        await tx.execute(
          `INSERT INTO submission_messages (submission_id, sender_type, body)
           VALUES (?, 'system', ?)`,
          [id, `Submission rejected. The reserved A-number has been returned to the pool.`],
        );
      }
    });
  } catch (err) {
    console.error("review action failed", err);
    return badRequest("Could not save the review. Try again.", 500);
  }

  // Fire-and-forget decision email. Only fires if we have both an address and
  // a notify_token (the plaintext tracking code) — see submit.ts for why
  // those two travel together. For approvals we use the (still-set) A-number;
  // for rejections that number has been freed, so use the now-empty string.
  if (exists.submitter_email && exists.notify_token) {
    const eahIdForEmail =
      action === "approve" && exists.eah_number !== null
        ? formatEahId(exists.eah_number)
        : "";
    void sendDecision({
      to: exists.submitter_email,
      eahId: eahIdForEmail,
      publicId: exists.public_id,
      trackingCode: exists.notify_token,
      modelLabel: exists.ai_model ?? "(unknown)",
      decision: action === "approve" ? "approved" : "rejected",
      staffReviewMessage,
      rejectionReason: action === "approve" ? null : rejectionReason,
    });
  }

  return new Response(null, { status: 303, headers: { Location: "/admin/queue" } });
}

/**
 * POST /admin/queue/:id/message — staff posts a chat message into a draft's
 * reviewer thread. Emails the submitter if they gave us an address.
 */
export async function postReviewMessage(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) {
    return new Response(null, { status: 303, headers: { Location: "/admin/login" } });
  }

  const idStr = ctx.params.id;
  const id = idStr && /^\d+$/.test(idStr) ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id) || id <= 0) {
    return badRequest("Invalid submission id.", 404);
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 16 * 1024);
  } catch {
    return badRequest("The form submission was too large or malformed.");
  }

  if (!verifyCsrf(req, form.get("_csrf"))) return csrfErrorResponse();

  const body = sanitizeText(form.get("message") ?? "").trim();
  if (body.length === 0) {
    return new Response(null, {
      status: 303,
      headers: { Location: `/admin/queue/${id}` },
    });
  }
  if (body.length > 4000) {
    return badRequest("Message is too long (max 4000 characters).");
  }

  const exists = await queryOne<{
    id: number;
    eah_number: number | null;
    ai_model: string | null;
    submitter_email: string | null;
    notify_token: string | null;
  }>(
    "SELECT id, eah_number, ai_model, submitter_email, notify_token FROM submissions WHERE id = ?",
    [id],
  );
  if (!exists) return badRequest("Submission not found.", 404);

  await execute(
    `INSERT INTO submission_messages (submission_id, sender_type, sender_admin_id, body)
     VALUES (?, 'staff', ?, ?)`,
    [id, ctx.admin.adminId, body],
  );

  // Fire-and-forget email notification to the submitter (if they gave one).
  if (exists.submitter_email && exists.notify_token) {
    void sendReviewerMessage({
      to: exists.submitter_email,
      eahId: formatEahId(exists.eah_number),
      trackingCode: exists.notify_token,
      modelLabel: exists.ai_model ?? "(unknown)",
      reviewerName: ctx.admin.username,
      bodyPreview: body,
    });
  }

  return new Response(null, {
    status: 303,
    headers: { Location: `/admin/queue/${id}` },
  });
}
