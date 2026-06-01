/**
 * Hallucination categories.
 *
 * Categories live in the `categories` table (so staff can add new ones at
 * runtime — see /admin/categories), but the rest of the codebase consumes them
 * through the *synchronous* helpers below. To square those two facts we keep a
 * module-level cache (`CATEGORIES`) that mirrors the table. The cache is seeded
 * with DEFAULT_CATEGORIES at import time so synchronous consumers work even
 * before the DB load, and `loadCategories()` refreshes it from the table at
 * server startup (and again whenever `addCategory()` adds one).
 *
 * Why a mutable module array instead of re-querying per request: category reads
 * happen on nearly every page (browse, submit, review, about…) and the set is
 * tiny and rarely changes. A cache refreshed on writes is far cheaper than a
 * query per render, and keeps `categoryLabel`/`isValidCategory` synchronous.
 */
import { query, execute, transaction } from "./db.ts";

export interface Category {
  key: string;
  label: string;
  description: string;
}

/**
 * The categories the site ships with. Also the seed list `migrate.ts` writes
 * into the `categories` table on first run. Editing this list does NOT remove
 * staff-added categories from the DB — it only changes what a fresh DB starts
 * with — so treat it as the initial seed, not the source of truth.
 */
export const DEFAULT_CATEGORIES: readonly Category[] = [
  {
    key: "tokenization",
    label: "Tokenization / Letter-Counting",
    description:
      "Errors caused by the model not seeing individual characters — counting letters, spelling, character-level edits.",
  },
  {
    key: "fabricated-citation",
    label: "Fabricated Citation",
    description: "Invented papers, books, URLs, court cases, or quotes that do not exist.",
  },
  {
    key: "spiraling",
    label: "Spiraling / Looping / Thrashing",
    description:
      "Outputs that degenerate into repetition, nonsense, or runaway tangents (e.g. the seahorse emoji thing).",
  },
  {
    key: "fake-code-api",
    label: "Fake Code / API",
    description: "Invented functions, library APIs, CLI flags, or import paths that do not exist.",
  },
  {
    key: "math-arithmetic",
    label: "Math / Arithmetic",
    description: "Wrong arithmetic, wrong calculations, wrong unit conversions.",
  },
  {
    key: "factual-error",
    label: "Factual Error",
    description: "Confident wrong claims about people, places, events, or science.",
  },
  {
    key: "temporal",
    label: "Temporal Confusion",
    description: "Confusion about dates, recency, or what the model can know given its training cutoff.",
  },
  {
    key: "instruction-following",
    label: "Instruction-Following Failure",
    description: "The model claims to have done something it didn't, or ignores explicit constraints.",
  },
  {
    key: "misleading",
    label: "Misleading / Overconfident",
    description:
      "Outputs that are not strictly false but present contested, subjective, or one-sided claims as settled fact — e.g. confidently declaring one historical figure superior to another when no clear ground truth exists.",
  },
  {
    key: "other",
    label: "Other",
    description: "Anything not covered above.",
  },
] as const;

/**
 * Live category cache. Seeded with the defaults so synchronous consumers work
 * before `loadCategories()` runs. Mutated IN PLACE on load so existing
 * `import { CATEGORIES }` references stay valid (no live-binding reassignment).
 */
export const CATEGORIES: Category[] = DEFAULT_CATEGORIES.map((c) => ({ ...c }));

let CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

function rebuildKeyset(): void {
  CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));
}

/**
 * Keep "Other" pinned to the end regardless of insertion order. The table is
 * read `ORDER BY id ASC` and "other" is seeded early, so without this any
 * staff-added category would sort ahead of it. Array.sort is stable in Bun, so
 * non-"other" entries keep their existing relative order. Mutates in place.
 */
function pinOtherLast(): void {
  CATEGORIES.sort((a, b) => Number(a.key === "other") - Number(b.key === "other"));
}
pinOtherLast();

/**
 * Refresh the in-memory cache from the `categories` table. Called once at
 * server startup and after each `addCategory`. If the table is empty or the
 * query fails, the cache keeps its current (default) contents.
 */
export async function loadCategories(): Promise<void> {
  try {
    const rows = await query<Category>(
      "SELECT `key`, label, description FROM categories ORDER BY id ASC",
    );
    if (rows.length > 0) {
      CATEGORIES.length = 0;
      for (const r of rows) {
        CATEGORIES.push({ key: r.key, label: r.label, description: r.description ?? "" });
      }
      pinOtherLast();
      rebuildKeyset();
    }
  } catch {
    // No categories table yet (pre-migration) or DB hiccup — keep defaults.
  }
}

/** Slugify a label into a candidate category key: lowercase, hyphenated. */
export function slugifyCategoryKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const KEY_RE = /^[a-z0-9-]+$/;

/**
 * Insert a new category and refresh the cache. Returns the created category, or
 * an error describing why it was rejected (bad key, duplicate, blocked).
 */
export async function addCategory(
  label: string,
  description: string,
  explicitKey?: string,
): Promise<{ ok: true; category: Category } | { ok: false; error: string }> {
  const trimmedLabel = label.trim();
  if (trimmedLabel.length === 0) return { ok: false, error: "Category label is required." };
  if (trimmedLabel.length > 120) return { ok: false, error: "Category label is too long (max 120)." };
  if (description.length > 1000) return { ok: false, error: "Description is too long (max 1000)." };

  const key = (explicitKey && explicitKey.trim().length > 0)
    ? explicitKey.trim().toLowerCase()
    : slugifyCategoryKey(trimmedLabel);

  if (!KEY_RE.test(key)) {
    return { ok: false, error: "Key must be lowercase letters, digits, and hyphens only." };
  }
  if (key.length > 40) return { ok: false, error: "Key is too long (max 40)." };
  // House rule: no jailbreak category. Compiling working jailbreaks has obvious
  // downsides; enforced here so it can't be added through the staff form.
  if (key === "jailbreak" || /\bjailbreak\b/i.test(trimmedLabel)) {
    return { ok: false, error: "We don't catalog jailbreaks." };
  }
  if (CATEGORY_KEYS.has(key)) {
    return { ok: false, error: `A category with key "${key}" already exists.` };
  }

  try {
    await execute(
      "INSERT INTO categories (`key`, label, description) VALUES (?, ?, ?)",
      [key, trimmedLabel, description.trim()],
    );
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) {
      return { ok: false, error: `A category with key "${key}" already exists.` };
    }
    throw err;
  }

  await loadCategories();
  return { ok: true, category: { key, label: trimmedLabel, description: description.trim() } };
}

/**
 * Delete a category and reassign its submissions in one transaction.
 * `reassignTo` must be "" (uncategorized) or a currently valid category key
 * that is NOT the category being deleted.
 */
export async function deleteCategory(
  key: string,
  reassignTo: string,
): Promise<{ ok: true; affected: number } | { ok: false; error: string }> {
  if (!CATEGORY_KEYS.has(key)) return { ok: false, error: "Category not found." };
  if (reassignTo !== "" && !CATEGORY_KEYS.has(reassignTo)) {
    return { ok: false, error: "Reassign target is not a valid category." };
  }
  if (reassignTo === key) {
    return { ok: false, error: "Cannot reassign to the same category." };
  }

  const affected = await transaction(async (tx) => {
    const res = await tx.execute(
      "UPDATE submissions SET category = ? WHERE category = ?",
      [reassignTo, key],
    );
    await tx.execute("DELETE FROM categories WHERE `key` = ?", [key]);
    return res.affectedRows;
  });

  await loadCategories();
  return { ok: true, affected };
}

export function isValidCategory(key: string): boolean {
  return CATEGORY_KEYS.has(key);
}

export function categoryLabel(key: string): string {
  // Category is optional at submission time; staff assign one before publish.
  // An empty key is an as-yet-uncategorized submission (drafts / pending only).
  if (!key) return "uncategorized";
  return CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

/**
 * Resolve a free-text search term to a category key, so the search box can
 * double as a category filter. Matches (case-insensitively) against the key,
 * the key with hyphens as spaces, the full label, or any slash-separated
 * segment of the label (e.g. "math", "arithmetic", "api", "looping").
 * Returns null when the term doesn't name a category.
 */
export function resolveCategory(input: string): string | null {
  const norm = input.trim().toLowerCase();
  if (norm.length === 0) return null;
  for (const c of CATEGORIES) {
    if (c.key === norm) return c.key;
    if (c.key.replace(/-/g, " ") === norm) return c.key;
    if (c.label.toLowerCase() === norm) return c.key;
    const segments = c.label.toLowerCase().split("/").map((s) => s.trim());
    if (segments.includes(norm)) return c.key;
  }
  return null;
}
