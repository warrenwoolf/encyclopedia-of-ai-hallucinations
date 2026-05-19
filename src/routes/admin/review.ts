/**
 * Admin review action.
 *
 *   POST /admin/queue/:id   — approve or reject a submission
 */
import { h } from "../../html.ts";
import { layout } from "../../layout.ts";
import { execute, queryOne } from "../../db.ts";
import { verifyCsrf } from "../../csrf.ts";
import { htmlResponse, parseForm, type RouteContext } from "../types.ts";

function badRequest(message: string, status = 400): Response {
  const body = layout({
    title: "Bad request",
    heading: "Bad request",
    body: h`<p>${message} <a href="javascript:history.back()">Go back</a>.</p>`,
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

/** Trim and null-ify empty text, enforcing a max length. */
function parseText(raw: string | null, name: string, max: number): string | null {
  if (raw === null) return null;
  const v = raw.trim();
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
  try {
    verifiedHits = parseBoundedInt(form.get("verified_hits"), "verified_hits");
    verifiedTotal = parseBoundedInt(form.get("verified_total"), "verified_total");
    reviewerNotes = parseText(form.get("reviewer_notes"), "reviewer_notes", 4000);
    rejectionReason = parseText(form.get("rejection_reason"), "rejection_reason", 1000);
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
  const exists = await queryOne<{ id: number }>("SELECT id FROM submissions WHERE id = ?", [id]);
  if (!exists) return badRequest("Submission not found.", 404);

  if (action === "approve") {
    await execute(
      `UPDATE submissions
          SET status = 'published',
              reviewed_by = ?,
              reviewed_at = NOW(),
              verified_hits = ?,
              verified_total = ?,
              reviewer_notes = ?,
              rejection_reason = NULL
        WHERE id = ?`,
      [ctx.admin.adminId, verifiedHits, verifiedTotal, reviewerNotes, id],
    );
  } else {
    await execute(
      `UPDATE submissions
          SET status = 'rejected',
              reviewed_by = ?,
              reviewed_at = NOW(),
              rejection_reason = ?,
              reviewer_notes = ?,
              verified_hits = ?,
              verified_total = ?
        WHERE id = ?`,
      [ctx.admin.adminId, rejectionReason, reviewerNotes, verifiedHits, verifiedTotal, id],
    );
  }

  return new Response(null, { status: 303, headers: { Location: "/admin/queue" } });
}
