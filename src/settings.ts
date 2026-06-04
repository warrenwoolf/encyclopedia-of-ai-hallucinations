/**
 * Owner-tunable site settings, cached in memory.
 *
 * Currently holds a single value: `repro_threshold` — how many distinct staff
 * confirmations are required to accept (reproduce) or reject (fail) a
 * pending-acceptance entry. A single owner vote is always decisive; this number
 * only governs the staff-only path (see src/routes/admin/review.ts).
 *
 * Mirrors the src/categories.ts pattern: the DB (`site_settings` table) is the
 * source of truth, but reads go through an in-memory cache primed at boot by
 * loadSettings(). Writes update both the DB and the cache. loadSettings()
 * fails open to the defaults if the table doesn't exist yet (fresh DB before
 * the first migrate), so the server still boots.
 */
import { query, execute } from "./db.ts";

export const REPRO_THRESHOLD_KEY = "repro_threshold";
export const DEFAULT_REPRO_THRESHOLD = 3;
export const MIN_REPRO_THRESHOLD = 1;
export const MAX_REPRO_THRESHOLD = 50;

let reproThreshold = DEFAULT_REPRO_THRESHOLD;

/** Current required number of staff confirmations to accept/reject reproduction. */
export function getReproThreshold(): number {
  return reproThreshold;
}

/** Prime the cache from the DB. Call once at startup; safe to re-run. */
export async function loadSettings(): Promise<void> {
  const rows = await query<{ key: string; value: string }>(
    "SELECT `key`, value FROM site_settings",
  );
  for (const r of rows) {
    if (r.key === REPRO_THRESHOLD_KEY) {
      const n = parseInt(r.value, 10);
      if (Number.isFinite(n) && n >= MIN_REPRO_THRESHOLD && n <= MAX_REPRO_THRESHOLD) {
        reproThreshold = n;
      }
    }
  }
}

/** Persist and cache a new reproduction threshold. Validates bounds. */
export async function setReproThreshold(
  n: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isInteger(n) || n < MIN_REPRO_THRESHOLD || n > MAX_REPRO_THRESHOLD) {
    return {
      ok: false,
      error: `Threshold must be a whole number between ${MIN_REPRO_THRESHOLD} and ${MAX_REPRO_THRESHOLD}.`,
    };
  }
  await execute(
    "INSERT INTO site_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    [REPRO_THRESHOLD_KEY, String(n)],
  );
  reproThreshold = n;
  return { ok: true };
}
