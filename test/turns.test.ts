/**
 * Unit tests for the pure multi-turn transcript helpers (src/turns.ts).
 */
import { test, expect, describe } from "bun:test";
import {
  splitBlock,
  deriveLegacyPair,
  validateTurns,
  readTranscriptForm,
  applyTurnAction,
  effectiveTurns,
  serializeTranscript,
  normalizeMode,
  MAX_TURNS,
  type Turn,
} from "../src/turns.ts";

const identity = (s: string) => s;

describe("splitBlock", () => {
  test("splits on ### User / ### Assistant delimiters", () => {
    const block = "### User\nWhat is 2+2?\n### Assistant\n5";
    expect(splitBlock(block)).toEqual([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "5" },
    ]);
  });

  test("accepts <<USER>> / <<ASSISTANT>> markers, case-insensitive", () => {
    const block = "<<user>>\nhi\n<<ASSISTANT>>\nhello";
    expect(splitBlock(block)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  test("no delimiters → single user turn with the whole block", () => {
    expect(splitBlock("just a blob\nof text")).toEqual([
      { role: "user", content: "just a blob\nof text" },
    ]);
  });

  test("text before the first delimiter is preserved as a leading user turn", () => {
    const block = "preamble line\n### Assistant\nreply";
    expect(splitBlock(block)).toEqual([
      { role: "user", content: "preamble line" },
      { role: "assistant", content: "reply" },
    ]);
  });

  test("drops empty turns from back-to-back delimiters", () => {
    const block = "### User\n### User\nq\n### Assistant\na";
    expect(splitBlock(block)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
  });
});

describe("deriveLegacyPair", () => {
  test("first user + first assistant", () => {
    const turns: Turn[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ];
    expect(deriveLegacyPair(turns)).toEqual({ prompt: "q1", output: "a1" });
  });

  test("single user turn → output falls back to empty", () => {
    expect(deriveLegacyPair([{ role: "user", content: "only" }])).toEqual({ prompt: "only", output: "" });
  });
});

describe("validateTurns", () => {
  test("rejects all-empty", () => {
    const r = validateTurns([{ role: "user", content: "  " }]);
    expect(r.ok).toBe(false);
  });

  test("drops empty turns and trims trailing whitespace", () => {
    const r = validateTurns([
      { role: "user", content: "q  \n" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "a" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.turns).toEqual([
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ]);
    }
  });

  test("rejects more than MAX_TURNS", () => {
    const many: Turn[] = Array.from({ length: MAX_TURNS + 1 }, () => ({ role: "user" as const, content: "x" }));
    const r = validateTurns(many);
    expect(r.ok).toBe(false);
  });
});

describe("readTranscriptForm", () => {
  test("turns mode pairs turn_role / turn_content by index", () => {
    const form = new URLSearchParams();
    form.set("transcript_mode", "turns");
    form.append("turn_role", "user");
    form.append("turn_content", "q1");
    form.append("turn_role", "assistant");
    form.append("turn_content", "a1");
    const r = readTranscriptForm(form, identity);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe("turns");
      expect(r.turns).toEqual([
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
      ]);
    }
  });

  test("block mode splits the pasted textarea", () => {
    const form = new URLSearchParams();
    form.set("transcript_mode", "block");
    form.set("transcript_block", "### User\nhi\n### Assistant\nyo");
    const r = readTranscriptForm(form, identity);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe("block");
      expect(r.turns).toHaveLength(2);
    }
  });

  test("empty turns mode is rejected", () => {
    const form = new URLSearchParams();
    form.set("transcript_mode", "turns");
    form.append("turn_role", "user");
    form.append("turn_content", "");
    expect(readTranscriptForm(form, identity).ok).toBe(false);
  });
});

describe("applyTurnAction", () => {
  test("add_turn appends an alternating-role empty turn", () => {
    const next = applyTurnAction("add_turn", [{ role: "user", content: "q" }]);
    expect(next).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "" },
    ]);
  });

  test("remove_turn:N drops that index", () => {
    const next = applyTurnAction("remove_turn:0", [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    expect(next).toEqual([{ role: "assistant", content: "a" }]);
  });

  test("removing the last turn leaves one empty box", () => {
    const next = applyTurnAction("remove_turn:0", [{ role: "user", content: "q" }]);
    expect(next).toEqual([{ role: "user", content: "" }]);
  });

  test("non-turn actions return null", () => {
    expect(applyTurnAction("propose", [])).toBeNull();
  });
});

describe("effectiveTurns / serializeTranscript / normalizeMode", () => {
  test("single mode synthesizes [prompt, output]", () => {
    expect(effectiveTurns("single", [], "p", "o")).toEqual([
      { role: "user", content: "p" },
      { role: "assistant", content: "o" },
    ]);
  });

  test("turns mode uses stored turns", () => {
    const stored: Turn[] = [{ role: "user", content: "x" }];
    expect(effectiveTurns("turns", stored, "p", "o")).toEqual(stored);
  });

  test("serializeTranscript returns null for single", () => {
    expect(serializeTranscript("single", [{ role: "user", content: "x" }])).toBeNull();
  });

  test("serializeTranscript returns null for link (tracked via source_url)", () => {
    expect(serializeTranscript("link", [])).toBeNull();
  });

  test("normalizeMode defaults unknown to single, passes through link", () => {
    expect(normalizeMode("bogus")).toBe("single");
    expect(normalizeMode("block")).toBe("block");
    expect(normalizeMode("link")).toBe("link");
  });
});
