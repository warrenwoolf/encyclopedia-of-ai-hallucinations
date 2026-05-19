/** Fixed set of hallucination categories. Single source of truth. */

export interface Category {
  key: string;
  label: string;
  description: string;
}

export const CATEGORIES: readonly Category[] = [
  {
    key: "tokenization",
    label: "Tokenization / Letter-counting",
    description:
      "Errors caused by the model not seeing individual characters — counting letters, spelling, character-level edits.",
  },
  {
    key: "fabricated-citation",
    label: "Fabricated citation",
    description: "Invented papers, books, URLs, court cases, or quotes that do not exist.",
  },
  {
    key: "spiraling",
    label: "Spiraling / Looping",
    description:
      "Outputs that degenerate into repetition, nonsense, or runaway tangents (e.g. the seahorse emoji thing).",
  },
  {
    key: "fake-code-api",
    label: "Fake code / API",
    description: "Invented functions, library APIs, CLI flags, or import paths that do not exist.",
  },
  {
    key: "math-arithmetic",
    label: "Math / Arithmetic",
    description: "Wrong arithmetic, wrong calculations, wrong unit conversions.",
  },
  {
    key: "factual-error",
    label: "Factual error",
    description: "Confident wrong claims about people, places, events, or science.",
  },
  {
    key: "temporal",
    label: "Temporal confusion",
    description: "Confusion about dates, recency, or what the model can know given its training cutoff.",
  },
  {
    key: "instruction-following",
    label: "Instruction-following failure",
    description: "The model claims to have done something it didn't, or ignores explicit constraints.",
  },
  {
    key: "other",
    label: "Other",
    description: "Anything not covered above.",
  },
] as const;

const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

export function isValidCategory(key: string): boolean {
  return CATEGORY_KEYS.has(key);
}

export function categoryLabel(key: string): string {
  return CATEGORIES.find((c) => c.key === key)?.label ?? key;
}
