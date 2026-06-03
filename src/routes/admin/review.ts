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
import { notifyPublished } from "../../discord.ts";
import { allocateEahNumber, freeEahNumber, formatEahId } from "../../eah-id.ts";
import { isValidCategory, categoryLabel } from "../../categories.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteContext } from "../types.ts";

async function badRequest(message: string, status = 400, returnTo?: string): Promise<Response> {
  const link = returnTo
    ? h` <a href="${returnTo}">Return to the queue</a>.`
    : h` <a href="/admin/queue">Return to the queue</a>.`;
  const body = await layout({
    title: "Bad request",
    heading: "Bad request",
    body: h`<p>${message}${link}</p>`,
  });
  return htmlResponse(body, { status });
}

async function csrfErrorResponse(): Promise<Response> {
  const body = await layout({
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
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  const idStr = ctx.params.id;
  const id = idStr && /^\d+$/.test(idStr) ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id) || id <= 0) {
    return await badRequest("Invalid submission id.", 404);
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req);
  } catch {
    return await badRequest("The form submission was too large or malformed.");
  }

  if (!verifyCsrf(req, form.get("_csrf"))) return await csrfErrorResponse();

  // Tiered review actions:
  //   confirm   — unreviewed → reviewed (entry becomes a default-listed entry)
  //   reproduce — reviewed → reproduced (allocates the canonical A-number)
  //   fail      — reviewed → repro_status='failed' (reviewed but not reproducible)
  //   reject    — hard-delete the submission (used at the unreviewed stage)
  const action = form.get("action");
  if (action !== "confirm" && action !== "reproduce" && action !== "fail" && action !== "reject") {
    return await badRequest("Unknown review action.");
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
    return await badRequest(err instanceof Error ? err.message : "Invalid form input.");
  }

  // Sanity: total must be >= hits when both supplied.
  if (verifiedHits !== null && verifiedTotal !== null && verifiedTotal < verifiedHits) {
    return await badRequest("verified_total must be greater than or equal to verified_hits.");
  }
  // If only hits is supplied without total, that's nonsensical — reject.
  if (verifiedHits !== null && verifiedTotal === null) {
    return await badRequest("Provide verified_total if verified_hits is set.");
  }

  // Confirm the submission exists before update so we can return a proper 404.
  // Also pull the fields we'll need to compose the outbound email. The
  // notification address is the owner account's email (new account-only model);
  // legacy anonymous rows fall back to the now-unused submitter_email column.
  const exists = await queryOne<{
    id: number;
    public_id: string;
    eah_number: number | null;
    title: string | null;
    ai_model: string | null;
    category: string;
    status: string;
    repro_status: string;
    transcript_mode: string;
    submitter_email: string | null;
    owner_email: string | null;
  }>(
    `SELECT s.id, s.public_id, s.eah_number, s.title, s.ai_model, s.category,
            s.status, s.repro_status, s.transcript_mode, s.submitter_email,
            u.email AS owner_email
       FROM submissions s
       LEFT JOIN users u ON u.id = s.owner_user_id
      WHERE s.id = ?`,
    [id],
  );
  if (!exists) return await badRequest("Submission not found.", 404);

  // Link submissions cap at 'reviewed' — they can't be reproduced.
  if (action === "reproduce" && exists.transcript_mode === "link") {
    return await badRequest(
      "Link / social-media submissions can't be reproduced — they cap at 'reviewed'.",
      400,
      `/admin/queue/${id}`,
    );
  }

  // Category can be (re)assigned right here in the review form — staff no longer
  // need the edit form (or the submitter's edit consent) just to categorize.
  // A missing `category` field means "leave it unchanged"; an empty value means
  // "uncategorized"; a non-empty value must be a valid category key.
  let effectiveCategory = exists.category;
  const categoryRaw = form.get("category");
  if (categoryRaw !== null) {
    const c = categoryRaw.trim();
    if (c === "") {
      effectiveCategory = "";
    } else if (isValidCategory(c)) {
      effectiveCategory = c;
    } else {
      return await badRequest("Invalid category selected.", 400, `/admin/queue/${id}`);
    }
  }

  // Category is optional for submitters but required before an entry is confirmed
  // into the default-listed 'reviewed' tier. Staff pick one in the review form.
  if (action === "confirm" && !effectiveCategory) {
    return await badRequest(
      "This submission has no category. Choose one from the category dropdown in the review form before confirming.",
      400,
      `/admin/queue/${id}`,
    );
  }

  // Each transition (plus any number alloc/free) must be atomic. Track which
  // one actually fired so the right notification goes out afterward.
  let didReview = false;
  let didReproduce = false;
  let didFail = false;
  let didReject = false;
  let reproducedEahId = "";
  try {
    await transaction(async (tx) => {
      if (action === "confirm") {
        // unreviewed → reviewed. Guarded on the source status so an already-
        // decided row can't be silently re-confirmed.
        const res = await tx.execute(
          `UPDATE submissions
              SET status = 'reviewed',
                  category = ?,
                  reviewed_by = ?,
                  reviewed_at = NOW(),
                  verified_hits = ?,
                  verified_total = ?,
                  reviewer_notes = ?,
                  staff_review_message = ?,
                  rejection_reason = NULL
            WHERE id = ? AND status = 'unreviewed'`,
          [effectiveCategory, ctx.admin!.userId, verifiedHits, verifiedTotal, reviewerNotes, staffReviewMessage, id],
        );
        if (res.affectedRows > 0) {
          didReview = true;
          await tx.execute(
            `INSERT INTO submission_messages (submission_id, sender_type, body)
             VALUES (?, 'system', ?)`,
            [id, `Reviewed by staff — confirmed as a genuine submission and now publicly listed${staffReviewMessage ? ` (see reviewer note below)` : ``}.`],
          );
        }
      } else if (action === "reproduce") {
        // reviewed → reproduced. Allocate the canonical A-number here. Re-read
        // the row under a lock first so we never allocate against an ineligible
        // row (wrong status, link mode, or one that already has a number).
        const cur = await tx.queryOne<{ status: string; transcript_mode: string; eah_number: number | null }>(
          "SELECT status, transcript_mode, eah_number FROM submissions WHERE id = ? FOR UPDATE",
          [id],
        );
        if (cur && cur.status === "reviewed" && cur.transcript_mode !== "link" && cur.eah_number === null) {
          const n = await allocateEahNumber(tx);
          await tx.execute(
            `UPDATE submissions
                SET repro_status = 'reproduced',
                    eah_number = ?,
                    reviewed_by = ?,
                    reviewed_at = NOW(),
                    verified_hits = ?,
                    verified_total = ?,
                    reviewer_notes = ?
              WHERE id = ?`,
            [n, ctx.admin!.userId, verifiedHits, verifiedTotal, reviewerNotes, id],
          );
          didReproduce = true;
          reproducedEahId = formatEahId(n);
          await tx.execute(
            `INSERT INTO submission_messages (submission_id, sender_type, body)
             VALUES (?, 'system', ?)`,
            [id, `Reproduced by staff and assigned canonical number ${reproducedEahId}.`],
          );
        }
      } else if (action === "fail") {
        const res = await tx.execute(
          `UPDATE submissions
              SET repro_status = 'failed',
                  reviewed_by = ?,
                  reviewed_at = NOW(),
                  verified_hits = ?,
                  verified_total = ?,
                  reviewer_notes = ?
            WHERE id = ? AND status = 'reviewed'`,
          [ctx.admin!.userId, verifiedHits, verifiedTotal, reviewerNotes, id],
        );
        if (res.affectedRows > 0) {
          didFail = true;
          await tx.execute(
            `INSERT INTO submission_messages (submission_id, sender_type, body)
             VALUES (?, 'system', ?)`,
            [id, `Staff attempted reproduction and could not reproduce this entry.`],
          );
        }
      } else {
        // reject — hard-delete. Free any A-number first (defensive: only a
        // reproduced row would hold one). Child rows cascade via FK.
        await freeEahNumber(tx, id);
        await tx.execute("DELETE FROM submissions WHERE id = ?", [id]);
        didReject = true;
      }
    });
  } catch (err) {
    console.error("review action failed", err);
    return await badRequest("Could not save the review. Try again.", 500);
  }

  const notifyTo = exists.owner_email ?? exists.submitter_email;

  // An entry becomes publicly listed at the 'reviewed' tier — announce it on the
  // public Discord channel then (it has no A-number yet, so link by slug).
  if (didReview) {
    void notifyPublished({
      eahId: "",
      publicId: exists.public_id,
      title: exists.title,
      modelLabel: exists.ai_model ?? "(unknown)",
      categoryLabel: categoryLabel(effectiveCategory),
    });
    if (notifyTo) {
      void sendDecision({
        to: notifyTo,
        publicId: exists.public_id,
        modelLabel: exists.ai_model ?? "(unknown)",
        decision: "approved",
        staffReviewMessage,
        rejectionReason: null,
      });
    }
  }

  // Reproduction / failed-reproduction: notify the submitter by reviewer message.
  if (didReproduce && notifyTo) {
    void sendReviewerMessage({
      to: notifyTo,
      publicId: exists.public_id,
      eahId: reproducedEahId,
      modelLabel: exists.ai_model ?? "(unknown)",
      reviewerName: ctx.admin.username,
      bodyPreview: `Your entry was reproduced by staff and assigned the canonical number ${reproducedEahId}.`,
    });
  }
  if (didFail && notifyTo) {
    void sendReviewerMessage({
      to: notifyTo,
      publicId: exists.public_id,
      modelLabel: exists.ai_model ?? "(unknown)",
      reviewerName: ctx.admin.username,
      bodyPreview: `Staff reviewed your entry but could not reproduce it. It stays public as a reported, unreproduced sighting.`,
    });
  }

  // Rejection email: the row is gone, so there's no A-number to reference.
  if (didReject && notifyTo) {
    void sendDecision({
      to: notifyTo,
      publicId: exists.public_id,
      modelLabel: exists.ai_model ?? "(unknown)",
      decision: "rejected",
      staffReviewMessage,
      rejectionReason,
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
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  const idStr = ctx.params.id;
  const id = idStr && /^\d+$/.test(idStr) ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id) || id <= 0) {
    return await badRequest("Invalid submission id.", 404);
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 16 * 1024);
  } catch {
    return await badRequest("The form submission was too large or malformed.");
  }

  if (!verifyCsrf(req, form.get("_csrf"))) return await csrfErrorResponse();

  const body = sanitizeText(form.get("message") ?? "").trim();
  if (body.length === 0) {
    return new Response(null, {
      status: 303,
      headers: { Location: `/admin/queue/${id}` },
    });
  }
  if (body.length > 4000) {
    return await badRequest("Message is too long (max 4000 characters).");
  }

  const exists = await queryOne<{
    id: number;
    public_id: string;
    eah_number: number | null;
    ai_model: string | null;
    submitter_email: string | null;
    owner_email: string | null;
  }>(
    `SELECT s.id, s.public_id, s.eah_number, s.ai_model, s.submitter_email, u.email AS owner_email
       FROM submissions s
       LEFT JOIN users u ON u.id = s.owner_user_id
      WHERE s.id = ?`,
    [id],
  );
  if (!exists) return await badRequest("Submission not found.", 404);

  await execute(
    `INSERT INTO submission_messages (submission_id, sender_type, sender_user_id, body)
     VALUES (?, 'staff', ?, ?)`,
    [id, ctx.admin.userId, body],
  );

  // Fire-and-forget email notification: owner account email, else legacy.
  const messageTo = exists.owner_email ?? exists.submitter_email;
  if (messageTo) {
    void sendReviewerMessage({
      to: messageTo,
      publicId: exists.public_id,
      eahId: formatEahId(exists.eah_number),
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
