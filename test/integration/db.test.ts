/**
 * Integration suite — runs against a real MariaDB started by the preload
 * (test/setup.ts) when EAH_TEST_DB=1.
 *
 *   EAH_TEST_DB=1 bun test test/integration/
 *
 * Without the flag the whole describe is skipped (no Docker needed).
 *
 * IMPORTANT — single file on purpose: the throwaway container + connection pool
 * are shared across the run, so teardown (pool.end + container removal) must
 * happen exactly once. Splitting into multiple files would have each file's
 * afterAll kill the DB out from under the others. Keep all integration tests
 * here.
 *
 * Coverage is scoped to what the CURRENT migrated schema supports. The draft
 * workflow (submit-as-draft, my.ts edit/propose/withdraw/history,
 * submission_versions) is NOT covered because Bug L means its schema doesn't
 * exist — we can't even seed those rows. Once migrate.ts is fixed, add a
 * draft-flow block here.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  DB_ENABLED,
  truncateAll,
  stopTestDb,
  insertSubmission,
  insertUser,
  addTag,
  messageCount,
} from "./harness.ts";
import { pool, query, queryOne, execute, transaction } from "../../src/db.ts";
import { allocateEahNumber, freeEahNumber } from "../../src/eah-id.ts";
import {
  createSession,
  destroySession,
  getSessionFromRequest,
  issueVerificationCode,
  consumeVerificationCode,
} from "../../src/auth.ts";
import { tokenForRequest } from "../../src/csrf.ts";
import type { RouteContext } from "../../src/routes/types.ts";
import type { UserSession } from "../../src/auth.ts";

import { entry } from "../../src/routes/entry.ts";
import { submitPost } from "../../src/routes/submit.ts";
import { postReview } from "../../src/routes/admin/review.ts";
import { postBulk } from "../../src/routes/admin/bulk.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function ctx(opts: Partial<RouteContext> & { path?: string; ip?: string } = {}): RouteContext {
  return {
    params: opts.params ?? {},
    url: new URL(opts.path ?? "http://localhost:8090/"),
    ip: opts.ip ?? "10.0.0.1",
    user: opts.user ?? null,
    admin: opts.admin ?? null,
  };
}

function fakeAdmin(userId: number): UserSession {
  return {
    userId,
    username: "admin1",
    email: "admin1@example.com",
    isAdmin: true,
    emailVerified: true,
    token: "t",
  };
}

/** Build a CSRF-valid POST request (cookie token == form _csrf token). */
function csrfPost(
  path: string,
  fields: Record<string, string | string[]>,
  extraCookie?: string,
): Request {
  const { token } = tokenForRequest(new Request("http://localhost/"));
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const item of v) body.append(k, item);
    else body.append(k, v);
  }
  body.append("_csrf", token);
  const cookie = `eah_csrf=${token}` + (extraCookie ? `; ${extraCookie}` : "");
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: body.toString(),
  });
}

describe.skipIf(!DB_ENABLED)("integration (real MariaDB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await pool.end();
    await stopTestDb();
  });

  // ── A-number pool ───────────────────────────────────────────────────────────
  describe("A-number allocation against the real freed_eah_numbers pool", () => {
    test("first allocation is 1 when there are no submissions", async () => {
      expect(await transaction((tx) => allocateEahNumber(tx))).toBe(1);
    });

    test("next allocation is MAX(eah_number)+1", async () => {
      await insertSubmission({ eahNumber: 41, status: "published" });
      expect(await transaction((tx) => allocateEahNumber(tx))).toBe(42);
    });

    test("freeing returns the number to the pool, nulls the row, and reuses it", async () => {
      const id = await insertSubmission({ eahNumber: 5, status: "pending" });
      await transaction((tx) => freeEahNumber(tx, id));

      const row = await queryOne<{ eah_number: number | null }>(
        "SELECT eah_number FROM submissions WHERE id = ?",
        [id],
      );
      expect(row?.eah_number).toBeNull();
      const pooled = await query<{ n: number }>("SELECT n FROM freed_eah_numbers");
      expect(pooled.map((r) => Number(r.n))).toContain(5);
      expect(await transaction((tx) => allocateEahNumber(tx))).toBe(5);
    });

    test("smallest freed number is reused first", async () => {
      const a = await insertSubmission({ eahNumber: 8, status: "pending" });
      const b = await insertSubmission({ eahNumber: 3, status: "pending" });
      await transaction((tx) => freeEahNumber(tx, a));
      await transaction((tx) => freeEahNumber(tx, b));
      expect(await transaction((tx) => allocateEahNumber(tx))).toBe(3);
    });
  });

  // ── sessions ──────────────────────────────────────────────────────────────
  describe("session lifecycle", () => {
    test("a created session resolves back to the right user", async () => {
      const userId = await insertUser({ username: "test1", email: "test1@example.com" });
      const { token } = await createSession(userId);
      const session = await getSessionFromRequest(
        new Request("http://localhost/", { headers: { cookie: `eah_session=${token}` } }),
      );
      expect(session).not.toBeNull();
      expect(session!.userId).toBe(userId);
      expect(session!.username).toBe("test1");
      expect(session!.isAdmin).toBe(false);
    });

    test("the is_admin flag is reflected in the session", async () => {
      const userId = await insertUser({ username: "admin1", email: "a1@example.com", isAdmin: true });
      const { token } = await createSession(userId);
      const session = await getSessionFromRequest(
        new Request("http://localhost/", { headers: { cookie: `eah_session=${token}` } }),
      );
      expect(session!.isAdmin).toBe(true);
    });

    test("an unknown token resolves to null", async () => {
      const session = await getSessionFromRequest(
        new Request("http://localhost/", { headers: { cookie: `eah_session=${"0".repeat(64)}` } }),
      );
      expect(session).toBeNull();
    });

    test("an expired session is rejected and its row removed", async () => {
      const userId = await insertUser({ username: "test1", email: "test1@example.com" });
      const { token } = await createSession(userId);
      // Force the row to be expired.
      await execute("UPDATE user_sessions SET expires_at = NOW() - INTERVAL 1 DAY WHERE user_id = ?", [userId]);
      const session = await getSessionFromRequest(
        new Request("http://localhost/", { headers: { cookie: `eah_session=${token}` } }),
      );
      expect(session).toBeNull();
      const remaining = await query("SELECT 1 FROM user_sessions WHERE user_id = ?", [userId]);
      expect(remaining.length).toBe(0);
    });

    test("destroySession removes the session", async () => {
      const userId = await insertUser({ username: "test1", email: "test1@example.com" });
      const { token } = await createSession(userId);
      await destroySession(token);
      const session = await getSessionFromRequest(
        new Request("http://localhost/", { headers: { cookie: `eah_session=${token}` } }),
      );
      expect(session).toBeNull();
    });
  });

  // ── email verification codes ────────────────────────────────────────────────
  describe("email verification codes", () => {
    test("a correct code verifies the user and clears the row", async () => {
      const userId = await insertUser({ username: "test1", email: "test1@example.com", verified: false });
      const code = await issueVerificationCode(userId);
      const result = await consumeVerificationCode(userId, code);
      expect(result.ok).toBe(true);
      const user = await queryOne<{ email_verified: number }>(
        "SELECT email_verified FROM users WHERE id = ?",
        [userId],
      );
      expect(Number(user?.email_verified)).toBe(1);
      const left = await query("SELECT 1 FROM email_verifications WHERE user_id = ?", [userId]);
      expect(left.length).toBe(0);
    });

    test("a wrong code is a mismatch and increments attempts", async () => {
      const userId = await insertUser({ username: "test1", email: "test1@example.com", verified: false });
      const code = await issueVerificationCode(userId);
      const wrong = code === "000000" ? "111111" : "000000";
      const result = await consumeVerificationCode(userId, wrong);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("mismatch");
      const row = await queryOne<{ attempts: number }>(
        "SELECT attempts FROM email_verifications WHERE user_id = ?",
        [userId],
      );
      expect(Number(row?.attempts)).toBe(1);
    });

    test("the code is exhausted after 5 wrong attempts", async () => {
      const userId = await insertUser({ username: "test1", email: "test1@example.com", verified: false });
      const code = await issueVerificationCode(userId);
      const wrong = code === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i++) await consumeVerificationCode(userId, wrong);
      const result = await consumeVerificationCode(userId, wrong);
      expect(result.reason).toBe("exhausted");
    });

    test("an expired code reports 'expired'", async () => {
      const userId = await insertUser({ username: "test1", email: "test1@example.com", verified: false });
      const code = await issueVerificationCode(userId);
      await execute(
        "UPDATE email_verifications SET expires_at = NOW() - INTERVAL 1 HOUR WHERE user_id = ?",
        [userId],
      );
      const result = await consumeVerificationCode(userId, code);
      expect(result.reason).toBe("expired");
    });
  });

  // ── entry handler ─────────────────────────────────────────────────────────
  describe("GET /e/:public_id", () => {
    test("renders a published entry by A-number", async () => {
      const id = await insertSubmission({ eahNumber: 1, status: "published", title: "test1" });
      await addTag(id, "tag1");
      const res = await entry(
        new Request("http://x/e/A000001"),
        ctx({ params: { public_id: "A000001" } }),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("A000001");
      expect(html).toContain("tag1");
    });

    test("301-redirects a legacy public_id to the canonical A-number URL", async () => {
      await insertSubmission({ eahNumber: 2, status: "published", publicId: "legacyslg0" });
      const res = await entry(
        new Request("http://x/e/legacyslg0"),
        ctx({ params: { public_id: "legacyslg0" } }),
      );
      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe("/e/A000002");
    });

    test("404 for a non-published submission", async () => {
      await insertSubmission({ eahNumber: 3, status: "pending" });
      const res = await entry(
        new Request("http://x/e/A000003"),
        ctx({ params: { public_id: "A000003" } }),
      );
      expect(res.status).toBe(404);
    });

    test("prev/next navigation links the neighbouring published entries", async () => {
      await insertSubmission({ eahNumber: 1, status: "published" });
      await insertSubmission({ eahNumber: 2, status: "published" });
      await insertSubmission({ eahNumber: 3, status: "published" });
      const res = await entry(
        new Request("http://x/e/A000002"),
        ctx({ params: { public_id: "A000002" } }),
      );
      const html = await res.text();
      expect(html).toContain("/e/A000001"); // prev
      expect(html).toContain("/e/A000003"); // next
    });
  });

  // ── admin review (approve / reject) ──────────────────────────────────────────
  describe("POST /admin/queue/:id (review)", () => {
    test("approve publishes the submission and keeps its A-number", async () => {
      const id = await insertSubmission({ eahNumber: 10, status: "pending" });
      const res = await postReview(
        csrfPost(`/admin/queue/${id}`, { action: "approve" }),
        ctx({ params: { id: String(id) }, admin: fakeAdmin(1) }),
      );
      expect(res.status).toBe(303);
      const row = await queryOne<{ status: string; eah_number: number | null }>(
        "SELECT status, eah_number FROM submissions WHERE id = ?",
        [id],
      );
      expect(row?.status).toBe("published");
      expect(Number(row?.eah_number)).toBe(10);
      expect(await messageCount(id)).toBeGreaterThan(0); // system message posted
    });

    test("reject sets status='rejected' and frees the A-number", async () => {
      const id = await insertSubmission({ eahNumber: 11, status: "pending" });
      await postReview(
        csrfPost(`/admin/queue/${id}`, { action: "reject", rejection_reason: "test reason" }),
        ctx({ params: { id: String(id) }, admin: fakeAdmin(1) }),
      );
      const row = await queryOne<{ status: string; eah_number: number | null }>(
        "SELECT status, eah_number FROM submissions WHERE id = ?",
        [id],
      );
      expect(row?.status).toBe("rejected");
      expect(row?.eah_number).toBeNull();
      const pooled = await query<{ n: number }>("SELECT n FROM freed_eah_numbers");
      expect(pooled.map((r) => Number(r.n))).toContain(11);
    });

    test("rejects an invalid CSRF token with 403", async () => {
      const id = await insertSubmission({ eahNumber: 12, status: "pending" });
      const req = new Request(`http://localhost/admin/queue/${id}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "action=approve&_csrf=bogus",
      });
      const res = await postReview(req, ctx({ params: { id: String(id) }, admin: fakeAdmin(1) }));
      expect(res.status).toBe(403);
      const row = await queryOne<{ status: string }>("SELECT status FROM submissions WHERE id = ?", [id]);
      expect(row?.status).toBe("pending"); // unchanged
    });

    // BUG E: postReview's UPDATE has no `AND status='pending'` guard. Re-approving
    // an already-rejected submission (whose A-number was freed to NULL) republishes
    // it with a NULL eah_number — a broken state. Correct behavior: approving a
    // non-pending row should not publish it. EXPECTED TO FAIL until the guard is added.
    test("approving an already-rejected submission must NOT republish it (Bug E)", async () => {
      const id = await insertSubmission({ eahNumber: null, status: "rejected" });
      await postReview(
        csrfPost(`/admin/queue/${id}`, { action: "approve" }),
        ctx({ params: { id: String(id) }, admin: fakeAdmin(1) }),
      );
      const row = await queryOne<{ status: string; eah_number: number | null }>(
        "SELECT status, eah_number FROM submissions WHERE id = ?",
        [id],
      );
      // A published entry must never have a NULL A-number.
      expect(row?.status === "published" && row?.eah_number === null).toBe(false);
    });
  });

  // ── admin bulk ──────────────────────────────────────────────────────────────
  describe("POST /admin/bulk", () => {
    test("bulk-approve publishes all selected pending submissions", async () => {
      const a = await insertSubmission({ eahNumber: 20, status: "pending" });
      const b = await insertSubmission({ eahNumber: 21, status: "pending" });
      const res = await postBulk(
        csrfPost("/admin/bulk", { action: "approve", "ids[]": [String(a), String(b)] }),
        ctx({ admin: fakeAdmin(1) }),
      );
      expect(res.status).toBe(303);
      const rows = await query<{ status: string }>(
        "SELECT status FROM submissions WHERE id IN (?, ?)",
        [a, b],
      );
      expect(rows.every((r) => r.status === "published")).toBe(true);
    });

    test("bulk-reject frees the A-numbers", async () => {
      const a = await insertSubmission({ eahNumber: 22, status: "pending" });
      await postBulk(
        csrfPost("/admin/bulk", { action: "reject", "ids[]": [String(a)] }),
        ctx({ admin: fakeAdmin(1) }),
      );
      const row = await queryOne<{ status: string; eah_number: number | null }>(
        "SELECT status, eah_number FROM submissions WHERE id = ?",
        [a],
      );
      expect(row?.status).toBe("rejected");
      expect(row?.eah_number).toBeNull();
    });

    // BUG F: bulk guards the UPDATE with `AND status='pending'`, but posts the
    // "approved/rejected (bulk action)" system message unconditionally — even when
    // the row wasn't actually transitioned. Acting on an already-published row
    // should leave no spurious message. EXPECTED TO FAIL until the message insert
    // is gated on affectedRows.
    test("bulk action on an already-decided row posts no spurious message (Bug F)", async () => {
      const id = await insertSubmission({ eahNumber: 23, status: "published" });
      await postBulk(
        csrfPost("/admin/bulk", { action: "approve", "ids[]": [String(id)] }),
        ctx({ admin: fakeAdmin(1) }),
      );
      expect(await messageCount(id)).toBe(0);
    });
  });

  // ── submit handler (anonymous) ───────────────────────────────────────────────
  describe("POST /submit (anonymous)", () => {
    // BUG L blast radius: submit.ts's INSERT lists owner_user_id, a column
    // migrate.ts never adds. So even an anonymous submit fails at the DB and the
    // handler returns its 500 error page — no row is stored. EXPECTED TO FAIL
    // until migrate.ts is fixed; then a 'pending' row should be created.
    test("a valid anonymous submission is stored as 'pending'", async () => {
      const req = csrfPost("/submit", {
        title: "test1",
        prompt: "test prompt",
        output: "test output",
        ai_model: "test-model",
        category: "other",
      });
      await submitPost(req, ctx({ path: "http://localhost/submit", ip: "203.0.113.7" }));
      const rows = await query<{ status: string }>(
        "SELECT status FROM submissions WHERE status = 'pending'",
      );
      expect(rows.length).toBe(1);
    });
  });

  // ── schema gap (Bug L) ────────────────────────────────────────────────────────
  // migrate.ts was never updated for the draft overhaul. submit.ts / my.ts /
  // versions.ts depend on these. EXPECTED TO FAIL until migrate.ts is fixed.
  describe("migrate.ts builds the overhaul schema (SPEC — currently NOT satisfied)", () => {
    test("submissions.owner_user_id column exists", async () => {
      const col = await queryOne(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'submissions'
            AND COLUMN_NAME = 'owner_user_id'`,
      );
      expect(col).toBeDefined();
    });

    test("submission_versions table exists", async () => {
      const t = await queryOne(
        `SELECT TABLE_NAME FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'submission_versions'`,
      );
      expect(t).toBeDefined();
    });

    test("submissions.status enum includes 'draft'", async () => {
      const row = await queryOne<{ COLUMN_TYPE: string }>(
        `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'submissions'
            AND COLUMN_NAME = 'status'`,
      );
      expect(String(row?.COLUMN_TYPE)).toContain("'draft'");
    });
  });
});
