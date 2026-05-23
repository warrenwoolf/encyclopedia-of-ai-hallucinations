/**
 * Unit tests for the A-number system (src/eah-id.ts).
 *
 * formatEahId / parseEahId are pure. allocateEahNumber / freeEahNumber take a
 * TxLike, so we exercise them against an in-memory fake transaction — no DB.
 */
import { test, expect, describe } from "bun:test";
import {
  formatEahId,
  parseEahId,
  allocateEahNumber,
  freeEahNumber,
  type TxLike,
} from "../src/eah-id.ts";

describe("formatEahId", () => {
  test("zero-pads to 6 digits", () => {
    expect(formatEahId(1)).toBe("A000001");
    expect(formatEahId(123)).toBe("A000123");
    expect(formatEahId(123456)).toBe("A123456");
  });

  test("does not truncate numbers longer than 6 digits", () => {
    expect(formatEahId(1234567)).toBe("A1234567");
  });

  test("null/undefined render as empty string", () => {
    expect(formatEahId(null)).toBe("");
    expect(formatEahId(undefined)).toBe("");
  });
});

describe("parseEahId", () => {
  test("parses canonical and lowercase forms", () => {
    expect(parseEahId("A000001")).toBe(1);
    expect(parseEahId("a000123")).toBe(123);
    expect(parseEahId("A1")).toBe(1);
    expect(parseEahId("A123456")).toBe(123456);
  });

  test("trims surrounding whitespace", () => {
    expect(parseEahId("  A000042  ")).toBe(42);
  });

  test("rejects a bare integer (so /e/:id falls through to legacy public_id)", () => {
    // This is the documented behavior that keeps `a(1)=2`-style ids out.
    expect(parseEahId("2")).toBeNull();
  });

  test("rejects zero and empty/garbage", () => {
    expect(parseEahId("A000000")).toBeNull();
    expect(parseEahId("A0")).toBeNull();
    expect(parseEahId("")).toBeNull();
    expect(parseEahId(null)).toBeNull();
    expect(parseEahId(undefined)).toBeNull();
    expect(parseEahId("AAA")).toBeNull();
    expect(parseEahId("A12B")).toBeNull();
  });

  test("round-trips with formatEahId", () => {
    for (const n of [1, 9, 10, 999, 123456, 1000000]) {
      expect(parseEahId(formatEahId(n))).toBe(n);
    }
  });
});

// ── in-memory fake transaction ───────────────────────────────────────────────

interface FakeState {
  freed: number[];
  submissions: Map<number, { eah_number: number | null }>;
  maxEah: number;
}

function makeFakeTx(state: FakeState): TxLike {
  return {
    async query() {
      return [];
    },
    async queryOne<U = any>(sql: string, params: unknown[] = []): Promise<U | undefined> {
      if (/FROM freed_eah_numbers/i.test(sql)) {
        if (state.freed.length === 0) return undefined;
        const n = Math.min(...state.freed);
        return { n } as U;
      }
      if (/MAX\(eah_number\)/i.test(sql)) {
        return { m: state.maxEah } as U;
      }
      if (/SELECT eah_number FROM submissions WHERE id/i.test(sql)) {
        const id = Number(params[0]);
        const row = state.submissions.get(id);
        return (row ? { eah_number: row.eah_number } : undefined) as U;
      }
      return undefined;
    },
    async execute(sql: string, params: unknown[] = []) {
      if (/DELETE FROM freed_eah_numbers WHERE n/i.test(sql)) {
        const n = Number(params[0]);
        const i = state.freed.indexOf(n);
        if (i >= 0) state.freed.splice(i, 1);
        return { affectedRows: i >= 0 ? 1 : 0, insertId: 0 };
      }
      if (/UPDATE submissions SET eah_number = NULL/i.test(sql)) {
        const id = Number(params[0]);
        const row = state.submissions.get(id);
        if (row) row.eah_number = null;
        return { affectedRows: row ? 1 : 0, insertId: 0 };
      }
      if (/INSERT IGNORE INTO freed_eah_numbers/i.test(sql)) {
        const n = Number(params[0]);
        if (!state.freed.includes(n)) state.freed.push(n);
        return { affectedRows: 1, insertId: 0 };
      }
      return { affectedRows: 0, insertId: 0 };
    },
  };
}

describe("allocateEahNumber", () => {
  test("pops the smallest freed number when the pool is non-empty", async () => {
    const state: FakeState = { freed: [7, 3, 5], submissions: new Map(), maxEah: 100 };
    const n = await allocateEahNumber(makeFakeTx(state));
    expect(n).toBe(3);
    expect(state.freed.sort((a, b) => a - b)).toEqual([5, 7]); // 3 removed
  });

  test("uses MAX(eah_number)+1 when the pool is empty", async () => {
    const state: FakeState = { freed: [], submissions: new Map(), maxEah: 42 };
    const n = await allocateEahNumber(makeFakeTx(state));
    expect(n).toBe(43);
  });

  test("returns 1 for the very first allocation", async () => {
    const state: FakeState = { freed: [], submissions: new Map(), maxEah: 0 };
    expect(await allocateEahNumber(makeFakeTx(state))).toBe(1);
  });
});

describe("freeEahNumber", () => {
  test("nulls the row's eah_number and returns the integer to the pool", async () => {
    const state: FakeState = {
      freed: [],
      submissions: new Map([[10, { eah_number: 55 }]]),
      maxEah: 55,
    };
    await freeEahNumber(makeFakeTx(state), 10);
    expect(state.submissions.get(10)!.eah_number).toBeNull();
    expect(state.freed).toContain(55);
  });

  test("is a no-op when the submission already has a null eah_number", async () => {
    const state: FakeState = {
      freed: [],
      submissions: new Map([[10, { eah_number: null }]]),
      maxEah: 0,
    };
    await freeEahNumber(makeFakeTx(state), 10);
    expect(state.freed).toEqual([]);
  });

  test("a freed number is reused by the next allocation", async () => {
    const state: FakeState = {
      freed: [],
      submissions: new Map([[10, { eah_number: 12 }]]),
      maxEah: 99,
    };
    const tx = makeFakeTx(state);
    await freeEahNumber(tx, 10);
    expect(await allocateEahNumber(tx)).toBe(12);
  });
});
