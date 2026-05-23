/**
 * EAH A-number allocation and formatting.
 *
 * Every accepted-or-pending submission has a sequential integer (`eah_number`)
 * displayed everywhere as `A` + 6-digit zero-padded (`A000001`, `A123456`).
 *
 * Allocation policy (matches OEIS):
 *   - Assigned at DRAFT creation (in submit.ts, inside the insert transaction).
 *   - FREED when a draft is rejected or withdrawn. The integer goes into
 *     `freed_eah_numbers` and is reassigned to the next incoming draft.
 *   - LOCKED once a submission is published. Never recycled after publication.
 *
 * All functions here operate on a transaction handle so callers can compose
 * allocation with the rest of an insert/update in a single atomic block.
 */
import type { query as Query, execute as Execute, queryOne as QueryOne } from "./db.ts";

/** A submission/draft has been rejected or withdrawn — free its number. */
export type FreeReason = "rejected" | "withdrawn";

export interface TxLike {
  query: <U = any>(sql: string, params?: unknown[]) => Promise<U[]>;
  queryOne: <U = any>(sql: string, params?: unknown[]) => Promise<U | undefined>;
  execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows: number; insertId: number }>;
}

/**
 * Allocate the next available EAH number from inside an open transaction.
 *
 *   1. If there are any freed numbers in the pool, pop the smallest.
 *   2. Otherwise, return `MAX(eah_number) + 1` from submissions.
 *
 * The caller must immediately assign the returned number to a row in the same
 * transaction; otherwise it'll be re-used on the next call.
 */
export async function allocateEahNumber(tx: TxLike): Promise<number> {
  // FOR UPDATE prevents concurrent transactions from claiming the same freed number. This function MUST be called inside a transaction.
  const freed = await tx.queryOne<{ n: number }>(
    "SELECT n FROM freed_eah_numbers ORDER BY n ASC LIMIT 1 FOR UPDATE",
  );
  if (freed) {
    await tx.execute("DELETE FROM freed_eah_numbers WHERE n = ?", [freed.n]);
    return Number(freed.n);
  }
  const top = await tx.queryOne<{ m: number | null }>(
    "SELECT COALESCE(MAX(eah_number), 0) AS m FROM submissions",
  );
  return Number(top?.m ?? 0) + 1;
}

/**
 * Release the EAH number on a submission so the next incoming draft can claim
 * it. Safe to call multiple times: a NULL eah_number is left alone.
 *
 * MUST be called inside the same transaction that flips the submission's
 * status to rejected/withdrawn, otherwise a reader could see the number
 * paired with a "rejected" status — which we'd rather they didn't.
 */
export async function freeEahNumber(tx: TxLike, submissionId: number): Promise<void> {
  const row = await tx.queryOne<{ eah_number: number | null }>(
    "SELECT eah_number FROM submissions WHERE id = ?",
    [submissionId],
  );
  if (!row || row.eah_number === null || row.eah_number === undefined) return;
  const n = Number(row.eah_number);
  await tx.execute("UPDATE submissions SET eah_number = NULL WHERE id = ?", [submissionId]);
  // INSERT IGNORE: in the rare race where the same number is somehow already
  // in the pool, don't blow up — the pool just holds it once.
  await tx.execute("INSERT IGNORE INTO freed_eah_numbers (n) VALUES (?)", [n]);
}

/** Format a raw integer as an EAH ID: 1 → "A000001", 123456 → "A123456". */
export function formatEahId(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  const s = String(n);
  if (s.length >= 6) return `A${s}`;
  return `A${s.padStart(6, "0")}`;
}

/**
 * Parse an EAH-ID-looking string ("A000001", "a123") into the underlying
 * integer, or null if it doesn't match the pattern. Tolerant of lowercase 'a'
 * and of any leading zeros (or none at all).
 */
export function parseEahId(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^[Aa](\d{1,9})$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}
