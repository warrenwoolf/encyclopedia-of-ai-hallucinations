/**
 * Unit tests for the fixed category set (src/categories.ts).
 */
import { test, expect, describe } from "bun:test";
import { CATEGORIES, isValidCategory, categoryLabel } from "../src/categories.ts";

describe("CATEGORIES", () => {
  test("keys are unique", () => {
    const keys = CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every category has a non-empty label and description", () => {
    for (const c of CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  test('does NOT include a "jailbreak" category (per project policy)', () => {
    expect(CATEGORIES.some((c) => c.key === "jailbreak")).toBe(false);
  });
});

describe("isValidCategory", () => {
  test("accepts known keys", () => {
    expect(isValidCategory("tokenization")).toBe(true);
    expect(isValidCategory("fabricated-citation")).toBe(true);
    expect(isValidCategory("other")).toBe(true);
  });

  test("rejects unknown keys", () => {
    expect(isValidCategory("jailbreak")).toBe(false);
    expect(isValidCategory("")).toBe(false);
    expect(isValidCategory("TOKENIZATION")).toBe(false); // case-sensitive
  });
});

describe("categoryLabel", () => {
  test("returns the label for a known key", () => {
    expect(categoryLabel("math-arithmetic")).toBe("Math / Arithmetic");
  });

  test("falls back to the key for an unknown category", () => {
    expect(categoryLabel("nonsense-key")).toBe("nonsense-key");
  });
});
