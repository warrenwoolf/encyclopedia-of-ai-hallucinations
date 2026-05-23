/**
 * Bare-minimum integration suite — proves the Testcontainers harness works
 * end-to-end against a real MariaDB and exercises a couple of genuine DB code
 * paths the unit suite couldn't reach.
 *
 * Run with:   EAH_TEST_DB=1 bun test test/integration/
 * Without the flag the whole describe is skipped (no Docker needed).
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { DB_ENABLED, truncateAll, insertSubmission, insertUser, stopTestDb } from "./harness.ts";
import { pool, query, queryOne, transaction } from "../../src/db.ts";
import { allocateEahNumber, freeEahNumber } from "../../src/eah-id.ts";
import { createSession, getSessionFromRequest } from "../../src/auth.ts";

describe.skipIf(!DB_ENABLED)("integration (real MariaDB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await pool.end();
    await stopTestDb();
  });

  // ── proves the harness + real A-number pool logic ──────────────────────────
  describe("A-number allocation against the real freed_eah_numbers pool", () => {
    test("first allocation is 1 when there are no submissions", async () => {
      const n = await transaction((tx) => allocateEahNumber(tx));
      expect(n).toBe(1);
    });

    test("next allocation is MAX(eah_number)+1", async () => {
      await insertSubmission({ eahNumber: 41, status: "published" });
      const n = await transaction((tx) => allocateEahNumber(tx));
      expect(n).toBe(42);
    });

    test("freeing a number returns it to the pool, nulls the row, and reuses it", async () => {
      const id = await insertSubmission({ eahNumber: 5, status: "pending" });
      await transaction((tx) => freeEahNumber(tx, id));

      const row = await queryOne<{ eah_number: number | null }>(
        "SELECT eah_number FROM submissions WHERE id = ?",
        [id],
      );
      expect(row?.eah_number).toBeNull();

      const pooled = await query<{ n: number }>("SELECT n FROM freed_eah_numbers");
      expect(pooled.map((r) => Number(r.n))).toContain(5);

      // The freed number is handed out ahead of the high-water mark.
      const next = await transaction((tx) => allocateEahNumber(tx));
      expect(next).toBe(5);
    });
  });

  // ── proves a real auth round-trip (createSession + getSessionFromRequest) ───
  describe("session lifecycle", () => {
    test("a created session resolves back to the right user", async () => {
      const userId = await insertUser({ username: "test1", email: "test1@example.com" });
      const { token } = await createSession(userId);

      const req = new Request("http://localhost/", {
        headers: { cookie: `eah_session=${token}` },
      });
      const session = await getSessionFromRequest(req);

      expect(session).not.toBeNull();
      expect(session!.userId).toBe(userId);
      expect(session!.username).toBe("test1");
      expect(session!.isAdmin).toBe(false);
    });

    test("an unknown session token resolves to null", async () => {
      const req = new Request("http://localhost/", {
        headers: { cookie: `eah_session=${"0".repeat(64)}` },
      });
      expect(await getSessionFromRequest(req)).toBeNull();
    });
  });

  // ── pins Bug L: migrate.ts was never updated for the draft overhaul ─────────
  //
  // submit.ts / my.ts / versions.ts depend on owner_user_id, the 'draft' status
  // enum value, and the submission_versions table. migrate.ts creates none of
  // them, so the entire draft workflow (and even anonymous submit, whose INSERT
  // lists owner_user_id) breaks against a freshly-migrated DB. These three
  // assertions are EXPECTED TO FAIL until migrate.ts is fixed.
  describe("migrate.ts builds the overhaul schema (SPEC — currently NOT satisfied)", () => {
    test("submissions.owner_user_id column exists", async () => {
      const col = await queryOne(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'submissions'
            AND COLUMN_NAME = 'owner_user_id'`,
      );
      expect(col).toBeDefined();
    });

    test("submission_versions table exists", async () => {
      const t = await queryOne(
        `SELECT TABLE_NAME FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'submission_versions'`,
      );
      expect(t).toBeDefined();
    });

    test("submissions.status enum includes 'draft'", async () => {
      const row = await queryOne<{ COLUMN_TYPE: string }>(
        `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'submissions'
            AND COLUMN_NAME = 'status'`,
      );
      expect(String(row?.COLUMN_TYPE)).toContain("'draft'");
    });
  });
});
