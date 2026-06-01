/**
 * Lightweight similarity check for duplicate detection.
 * Uses Jaccard similarity on word-level token sets.
 * No external dependencies required.
 */

import { query } from "./db.ts";

/** Tokenize text into a set of lowercase word tokens, ignoring punctuation. */
function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/\b[a-z0-9]{3,}\b/g) ?? [];
  return new Set(tokens);
}

/** Jaccard similarity between two token sets. Returns 0..1. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) { if (b.has(t)) intersection++; }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface SimilarEntry {
  eah_number: number | null;
  title: string | null;
  score: number; // 0..1
}

/**
 * Find published or pending entries similar to the given prompt+output.
 * Returns matches above the threshold, sorted by descending score.
 * Excludes the submission with excludeId (the one being reviewed).
 */
export async function findSimilar(
  prompt: string,
  output: string,
  excludeId: number,
  threshold = 0.35,
  limit = 5,
): Promise<SimilarEntry[]> {
  // Fetch all published + pending entries (excluding the current one).
  // For large DBs this should be replaced with a DB-side trigram index,
  // but is fine for hundreds to low thousands of entries.
  const rows = await query<{
    id: number;
    eah_number: number | null;
    title: string | null;
    prompt: string;
    output: string;
  }>(
    `SELECT id, eah_number, title, prompt, output
     FROM submissions
     WHERE status IN ('reviewed', 'unreviewed')
       AND id != ?
     LIMIT 2000`,
    [excludeId],
  );

  const inputTokens = tokenize(prompt + " " + output);
  const results: SimilarEntry[] = [];

  for (const row of rows) {
    const rowTokens = tokenize(row.prompt + " " + row.output);
    const score = jaccard(inputTokens, rowTokens);
    if (score >= threshold) {
      results.push({ eah_number: row.eah_number, title: row.title, score });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
