/**
 * One-shot destructive cleanup of legacy schema bits.
 *
 * Idempotent: safe to re-run; checks the schema before each operation. After
 * the first successful run, every subsequent run prints "ok (nothing to do)".
 *
 * Steps:
 *   1. Move any rows still in `admins` into `users` (preserving id so we don't
 *      orphan submission_messages references). Sets a placeholder email and
 *      email_verified=0 — re-run seed-admin afterward with a real address.
 *   2. Move submission_messages.sender_admin_id -> sender_user_id:
 *      a. Add sender_user_id column if missing
 *      b. Copy data from sender_admin_id into sender_user_id (only where it
 *         points to an existing users.id; otherwise NULL)
 *      c. Add FK on sender_user_id -> users(id)
 *      d. Drop the old FK and column
 *   3. Drop admin_sessions, admins, email_sends.
 *   4. NULL out any bcrypt password_hashes (`$2*$…`) — bcrypt is no longer
 *      supported. Affected admins must re-run seed-admin to set an argon2
 *      hash.
 *
 * Usage: `bun run scripts/drop-legacy.ts`
 */
import { execute, query, queryOne, pool } from "../src/db.ts";

interface ColumnRow { COLUMN_NAME: string }
interface ConstraintRow { CONSTRAINT_NAME: string }

async function tableExists(name: string): Promise<boolean> {
  const r = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [name],
  );
  return Number(r?.c ?? 0) > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  return Number(r?.c ?? 0) > 0;
}

async function fkConstraints(table: string, column: string): Promise<string[]> {
  const rows = await query<ConstraintRow>(
    `SELECT CONSTRAINT_NAME FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
        AND referenced_table_name IS NOT NULL`,
    [table, column],
  );
  return rows.map((r) => r.CONSTRAINT_NAME);
}

async function step1_copyAdminsToUsers(): Promise<void> {
  if (!(await tableExists("admins"))) {
    console.log("ok  step 1 (admins table already gone)");
    return;
  }
  const legacy = await query<{ id: number; username: string; password_hash: string }>(
    "SELECT id, username, password_hash FROM admins",
  );
  let copied = 0;
  for (const a of legacy) {
    const existing = await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE username = ? OR id = ? LIMIT 1",
      [a.username, a.id],
    );
    if (existing) continue;
    const placeholderEmail = `${a.username}@admin.local`;
    try {
      // Preserve id so submission_messages.sender_admin_id -> users.id maps cleanly.
      await execute(
        `INSERT INTO users (id, username, email, email_verified, password_hash, is_admin)
         VALUES (?, ?, ?, 0, ?, 1)`,
        [a.id, a.username, placeholderEmail, a.password_hash],
      );
      copied++;
    } catch (err: any) {
      console.warn(`warn  step 1: could not copy ${a.username}:`, err?.code ?? err);
    }
  }
  console.log(`ok  step 1 (${copied} admins copied, ${legacy.length - copied} skipped)`);
}

async function step2_renameSenderColumn(): Promise<void> {
  if (!(await columnExists("submission_messages", "sender_admin_id"))) {
    console.log("ok  step 2 (sender_admin_id already gone)");
    return;
  }
  // 2a. Add new column if missing.
  if (!(await columnExists("submission_messages", "sender_user_id"))) {
    await execute(
      "ALTER TABLE submission_messages ADD COLUMN sender_user_id INT NULL AFTER sender_type",
    );
    console.log("ok  step 2a (sender_user_id added)");
  }
  // 2b. Copy data — but only where the referenced user exists. (Otherwise we'd
  // immediately violate the FK we're about to add.)
  await execute(
    `UPDATE submission_messages m
        LEFT JOIN users u ON u.id = m.sender_admin_id
        SET m.sender_user_id = u.id
      WHERE m.sender_admin_id IS NOT NULL`,
  );
  console.log("ok  step 2b (data copied)");

  // 2c. Add FK on the new column if missing.
  const newFks = await fkConstraints("submission_messages", "sender_user_id");
  if (newFks.length === 0) {
    await execute(
      `ALTER TABLE submission_messages
         ADD CONSTRAINT fk_sm_sender_user
         FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE SET NULL`,
    );
    console.log("ok  step 2c (FK on sender_user_id added)");
  }

  // 2d. Drop the old FK + column.
  const oldFks = await fkConstraints("submission_messages", "sender_admin_id");
  for (const c of oldFks) {
    await execute(`ALTER TABLE submission_messages DROP FOREIGN KEY \`${c}\``);
  }
  await execute("ALTER TABLE submission_messages DROP COLUMN sender_admin_id");
  console.log("ok  step 2d (sender_admin_id dropped)");
}

async function step3_dropLegacyTables(): Promise<void> {
  // Order matters because admin_sessions FKs admins.
  for (const t of ["admin_sessions", "admins", "email_sends"]) {
    if (await tableExists(t)) {
      await execute(`DROP TABLE \`${t}\``);
      console.log(`ok  step 3 (dropped ${t})`);
    }
  }
}

async function step4_nullBcryptHashes(): Promise<void> {
  // Any bcrypt hash in users.password_hash is now dead — verifyPassword only
  // accepts argon2. Setting NULL forces the affected user to re-seed (or
  // we'd need a reset flow which we don't have yet).
  const r = await execute(
    "UPDATE users SET password_hash = NULL WHERE password_hash LIKE '$2%'",
  );
  console.log(`ok  step 4 (nulled ${r.affectedRows} bcrypt password hash${r.affectedRows === 1 ? "" : "es"})`);
}

async function main(): Promise<number> {
  await step1_copyAdminsToUsers();
  await step2_renameSenderColumn();
  await step3_dropLegacyTables();
  await step4_nullBcryptHashes();
  console.log("");
  console.log("Done. If any admin had a bcrypt hash it's now NULL; re-run");
  console.log("scripts/seed-admin.ts with a real email and password to restore.");
  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error("drop-legacy failed:", err);
    try { await pool.end(); } catch {}
    process.exit(1);
  });
