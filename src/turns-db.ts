/**
 * DB helpers for multi-turn submission transcripts. Kept separate from the pure
 * `src/turns.ts` so that module stays unit-testable without a DB.
 *
 * The write path (`replaceTurns`) must run inside the same transaction that
 * sets submissions.transcript_mode + the prompt/output mirror, so a submission
 * is never left half-updated (mode says 'turns' but no rows, or vice versa).
 */
import { query } from "./db.ts";
import type { TxLike } from "./eah-id.ts";
import type { Turn } from "./turns.ts";

/** Load a submission's ordered turns. Empty array for legacy/'single' rows. */
export async function loadTurns(submissionId: number): Promise<Turn[]> {
  const rows = await query<{ role: "user" | "assistant"; content: string }>(
    `SELECT role, content FROM submission_turns
      WHERE submission_id = ? ORDER BY turn_index ASC, id ASC`,
    [submissionId],
  );
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

/**
 * Replace a submission's turn rows with `turns` (delete-then-insert). For
 * 'single' submissions pass an empty array — the row keeps using prompt/output.
 * Must be called inside an open transaction.
 */
export async function replaceTurns(
  tx: TxLike,
  submissionId: number,
  turns: Turn[],
): Promise<void> {
  await tx.execute("DELETE FROM submission_turns WHERE submission_id = ?", [submissionId]);
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    await tx.execute(
      "INSERT INTO submission_turns (submission_id, turn_index, role, content) VALUES (?, ?, ?, ?)",
      [submissionId, i, t.role, t.content],
    );
  }
}
