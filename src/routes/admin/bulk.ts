/**
 * Bulk approve/reject for the admin all-submissions view.
 *
 *   POST /admin/bulk
 *
 * Accepts a list of submission IDs (form field `ids[]`) and an `action`
 * ('approve' or 'reject').  Applies the same status transitions as the
 * per-item review route (review.ts) but WITHOUT sending decision emails —
 * bulk decisions are noisy enough that email per-entry would flood submitters.
 *
 * Transaction strategy: one transaction per ID rather than one giant
 * transaction for all IDs.  Rationale: MariaDB InnoDB row-locks within a
 * long multi-row transaction can create contention with live submitters
 * posting messages.  Per-ID transactions are atomically correct for each
 * individual item; if one fails (e.g. submission already decided), it is
 * skipped and the rest continue.  The redirect to /admin/all happens
 * regardless so staff can see the updated state.
 */
import { transaction } from "../../db.ts";
import { verifyCsrf } from "../../csrf.ts";
import { freeEahNumber } from "../../eah-id.ts";
import { parseForm, type RouteContext } from "../types.ts";

const MAX_IDS = 50;

export async function postBulk(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 64 * 1024);
  } catch {
    return new Response("Form too large", { status: 413 });
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    return new Response("Invalid CSRF token", { status: 403 });
  }

  const action = form.get("action");
  if (action !== "approve" && action !== "reject") {
    return new Response("Unknown action", { status: 400 });
  }

  // Collect and validate IDs.  getAll returns every `ids[]` value in the body.
  const rawIds = form.getAll("ids[]");
  const ids: number[] = [];
  for (const raw of rawIds) {
    const t = raw.trim();
    if (!/^\d+$/.test(t)) continue; // skip non-numeric
    const n = parseInt(t, 10);
    if (n > 0) ids.push(n);
    if (ids.length >= MAX_IDS) break;
  }

  const reviewedBy = ctx.admin.userId;
  const now = new Date();

  for (const id of ids) {
    try {
      await transaction(async (tx) => {
        if (action === "approve") {
          const res = await tx.execute(
            `UPDATE submissions
                SET status = 'published',
                    reviewed_by = ?,
                    reviewed_at = NOW(),
                    rejection_reason = NULL
              WHERE id = ? AND status = 'pending'`,
            [reviewedBy, id],
          );
          if (res.affectedRows > 0) {
            await tx.execute(
              `INSERT INTO submission_messages (submission_id, sender_type, body)
               VALUES (?, 'system', 'Submission approved and published (bulk action).')`,
              [id],
            );
          }
        } else {
          const res = await tx.execute(
            `UPDATE submissions
                SET status = 'rejected',
                    reviewed_by = ?,
                    reviewed_at = NOW()
              WHERE id = ? AND status = 'pending'`,
            [reviewedBy, id],
          );
          if (res.affectedRows > 0) {
            // OEIS rule: freed numbers return to the pool in the same tx.
            await freeEahNumber(tx, id);
            await tx.execute(
              `INSERT INTO submission_messages (submission_id, sender_type, body)
               VALUES (?, 'system', 'Submission rejected (bulk action).')`,
              [id],
            );
          }
        }
      });
    } catch (err) {
      // Log and continue — one bad ID should not abort the rest of the batch.
      console.error(`bulk action ${action} failed for id=${id}:`, err);
    }
  }

  // Suppress unused variable — `now` was declared but the query uses NOW().
  // Keep it here so callers can see the intended timestamp; MariaDB NOW() is
  // authoritative for the DB record.
  void now;

  return new Response(null, { status: 303, headers: { Location: "/admin/all" } });
}
