/**
 * Version-diff tracking for user-owned draft submissions.
 *
 * TRACKED_FIELDS lists every field we diff on save. All are compared as strings
 * (or null for blank/absent). The caller is responsible for serialization:
 *   - dates: "YYYY-MM-DD" or null
 *   - tags: sorted, comma-joined string of tag names (e.g. "counting,letter-r")
 *     → because tags live in a join table, the caller must query and serialize
 *       them before building currentValues/newValues.
 *   - entry_status: the raw enum string ("active" | "patched")
 *
 * Usage:
 *   await recordVersionDiffs(tx, submissionId, userId, currentValues, newValues);
 *
 * This MUST be called inside an open transaction — it reads MAX(version_num)
 * and inserts, so wrapping ensures the version_num is stable.
 */

import type { TxLike } from "./eah-id.ts";

export const TRACKED_FIELDS = [
  "title",
  "prompt",
  "output",
  "ai_model",
  "summary",
  "notes",
  "shared_chat_url",
  "category",
  "author_name",
  "hallucination_date",
  "entry_status",
  "tags",
  // Serialized multi-turn transcript (src/turns.ts serializeTranscript). Null
  // for single-turn rows, which are tracked via prompt/output instead.
  "transcript",
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

export type TrackedValues = Partial<Record<TrackedField, string | null>>;

/**
 * Compare currentValues to newValues and insert one row per changed field into
 * submission_versions. If no fields changed, no rows are inserted (and the
 * version_num counter is not advanced).
 *
 * @param tx          - open transaction handle
 * @param submissionId - the submission's primary-key id (not the A-number)
 * @param changedBy   - userId of the person making the edit (may be null for system)
 * @param currentValues - the field values as they exist in the DB right now
 * @param newValues   - the field values from the submitted form
 */
export async function recordVersionDiffs(
  tx: TxLike,
  submissionId: number,
  changedBy: number | null,
  currentValues: TrackedValues,
  newValues: TrackedValues,
): Promise<void> {
  // Compute diffs before touching the DB.
  const diffs: { field: TrackedField; old: string | null; new_: string | null }[] = [];
  for (const field of TRACKED_FIELDS) {
    const oldVal = currentValues[field] ?? null;
    const newVal = newValues[field] ?? null;
    if (oldVal !== newVal) {
      diffs.push({ field, old: oldVal, new_: newVal });
    }
  }

  // Nothing changed — don't burn a version_num.
  if (diffs.length === 0) return;

  // Compute the next version number inside the transaction so it's stable.
  const maxRow = await tx.queryOne<{ m: number }>(
    "SELECT COALESCE(MAX(version_num), 0) AS m FROM submission_versions WHERE submission_id = ?",
    [submissionId],
  );
  const nextVer = Number(maxRow?.m ?? 0) + 1;

  for (const { field, old, new_ } of diffs) {
    await tx.execute(
      `INSERT INTO submission_versions
         (submission_id, version_num, changed_by, field_name, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [submissionId, nextVer, changedBy, field, old, new_],
    );
  }
}
