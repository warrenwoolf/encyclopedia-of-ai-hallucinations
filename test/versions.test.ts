/**
 * Unit tests for version-diff recording (src/versions.ts) via an in-memory
 * fake transaction.
 */
import { test, expect, describe } from "bun:test";
import { recordVersionDiffs, TRACKED_FIELDS, type TrackedValues } from "../src/versions.ts";
import type { TxLike } from "../src/eah-id.ts";

interface Inserted {
  submission_id: number;
  version_num: number;
  changed_by: number | null;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
}

function makeTx(maxVersion: number): { tx: TxLike; inserts: Inserted[] } {
  const inserts: Inserted[] = [];
  const tx: TxLike = {
    async query() {
      return [];
    },
    async queryOne<U = any>(sql: string): Promise<U | undefined> {
      if (/MAX\(version_num\)/i.test(sql)) return { m: maxVersion } as U;
      return undefined;
    },
    async execute(sql: string, params: unknown[] = []) {
      if (/INSERT INTO submission_versions/i.test(sql)) {
        inserts.push({
          submission_id: params[0] as number,
          version_num: params[1] as number,
          changed_by: params[2] as number | null,
          field_name: params[3] as string,
          old_value: params[4] as string | null,
          new_value: params[5] as string | null,
        });
      }
      return { affectedRows: 1, insertId: inserts.length };
    },
  };
  return { tx, inserts };
}

describe("recordVersionDiffs", () => {
  test("records nothing when no field changed", async () => {
    const { tx, inserts } = makeTx(0);
    const values: TrackedValues = { title: "same", prompt: "p", output: "o" };
    await recordVersionDiffs(tx, 1, 7, values, { ...values });
    expect(inserts).toHaveLength(0);
  });

  test("records one row per changed field, all sharing the next version_num", async () => {
    const { tx, inserts } = makeTx(2); // next version should be 3
    const current: TrackedValues = { title: "old", prompt: "p", output: "o" };
    const next: TrackedValues = { title: "new", prompt: "p2", output: "o" };
    await recordVersionDiffs(tx, 99, 7, current, next);

    expect(inserts).toHaveLength(2); // title + prompt changed; output did not
    for (const ins of inserts) {
      expect(ins.submission_id).toBe(99);
      expect(ins.version_num).toBe(3);
      expect(ins.changed_by).toBe(7);
    }
    const byField = Object.fromEntries(inserts.map((i) => [i.field_name, i]));
    expect(byField.title).toMatchObject({ old_value: "old", new_value: "new" });
    expect(byField.prompt).toMatchObject({ old_value: "p", new_value: "p2" });
    expect(byField.output).toBeUndefined();
  });

  test("treats missing/undefined values as null and records additions", async () => {
    const { tx, inserts } = makeTx(0);
    await recordVersionDiffs(tx, 5, null, {}, { notes: "added a note" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      version_num: 1,
      changed_by: null,
      field_name: "notes",
      old_value: null,
      new_value: "added a note",
    });
  });

  test("TRACKED_FIELDS matches the documented field set", () => {
    expect([...TRACKED_FIELDS]).toEqual([
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
      "transcript",
    ]);
  });
});
