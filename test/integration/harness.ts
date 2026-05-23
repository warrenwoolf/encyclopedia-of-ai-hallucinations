/**
 * Helpers shared by the integration suite. These run against the real MariaDB
 * started by the preload (test/setup.ts) when EAH_TEST_DB=1.
 *
 * All seed data uses neutral placeholders ("test1", "test2", …) — never
 * realistic-looking hallucination content — so nobody mistakes a fixture for a
 * real entry.
 */
import { randomBytes } from "node:crypto";
import { execute, queryOne } from "../../src/db.ts";

/** True when the integration DB is configured. The suite is skipped otherwise. */
export const DB_ENABLED = process.env.EAH_TEST_DB === "1";

/**
 * Tables created by scripts/migrate.ts, child-first. NOTE: submission_versions
 * is intentionally absent — migrate.ts doesn't create it yet (see the schema-gap
 * tests). We DELETE rather than TRUNCATE so FK-referenced parents can be cleared
 * with checks disabled.
 */
const TABLES = [
  "submission_messages",
  "submission_tags",
  "email_verifications",
  "user_sessions",
  "freed_eah_numbers",
  "submissions",
  "tags",
  "users",
];

/** Wipe every table to a clean slate. Call at the top of each test. */
export async function truncateAll(): Promise<void> {
  await execute("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const t of TABLES) {
      await execute(`DELETE FROM ${t}`);
    }
  } finally {
    await execute("SET FOREIGN_KEY_CHECKS = 1");
  }
}

/** A random 10-char public_id (the column is CHAR(10) UNIQUE NOT NULL). */
export function randomPublicId(): string {
  return randomBytes(8).toString("base64url").slice(0, 10).padEnd(10, "0");
}

/**
 * Insert a minimal submission row using only columns migrate.ts actually
 * creates. Returns the new row's primary-key id. All text is placeholder.
 */
export async function insertSubmission(
  opts: {
    eahNumber?: number | null;
    status?: string;
    publicId?: string;
    title?: string | null;
  } = {},
): Promise<number> {
  const { insertId } = await execute(
    `INSERT INTO submissions
       (public_id, eah_number, tracking_hash, prompt, output, ai_model, category, status, title)
     VALUES (?, ?, ?, 'test', 'test', 'test', 'other', ?, ?)`,
    [
      opts.publicId ?? randomPublicId(),
      opts.eahNumber ?? null,
      randomBytes(32),
      opts.status ?? "pending",
      opts.title ?? null,
    ],
  );
  return insertId;
}

/** Attach a tag (by name) to a submission, creating the tag row if needed. */
export async function addTag(submissionId: number, name: string): Promise<void> {
  await execute("INSERT IGNORE INTO tags (name) VALUES (?)", [name]);
  const tag = await queryOne<{ id: number }>("SELECT id FROM tags WHERE name = ?", [name]);
  await execute(
    "INSERT IGNORE INTO submission_tags (submission_id, tag_id) VALUES (?, ?)",
    [submissionId, tag!.id],
  );
}

/** Count chat-thread messages for a submission. */
export async function messageCount(submissionId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM submission_messages WHERE submission_id = ?",
    [submissionId],
  );
  return Number(row?.n ?? 0);
}

/**
 * Remove the throwaway MariaDB container started by the preload. Safe to call
 * once in the integration suite's afterAll. No-op if no container was recorded.
 */
export async function stopTestDb(): Promise<void> {
  const name = (globalThis as Record<string, unknown>).__EAH_TEST_DB_CONTAINER as
    | string
    | undefined;
  if (!name) return;
  const p = Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

/** Insert a user; returns the new user id. */
export async function insertUser(
  opts: { username?: string; email?: string; isAdmin?: boolean; verified?: boolean } = {},
): Promise<number> {
  const { insertId } = await execute(
    `INSERT INTO users (username, email, email_verified, is_admin)
     VALUES (?, ?, ?, ?)`,
    [
      opts.username ?? "test1",
      opts.email ?? "test1@example.com",
      opts.verified === false ? 0 : 1,
      opts.isAdmin ? 1 : 0,
    ],
  );
  return insertId;
}
