/**
 * Idempotent schema bootstrap. Creates all tables for the Encyclopedia of AI
 * Hallucinations if they do not yet exist. Safe to run repeatedly.
 *
 * Usage: `bun run scripts/migrate.ts`
 */
import { execute, pool } from "../src/db.ts";

interface TableSpec {
  name: string;
  sql: string;
}

const TABLES: TableSpec[] = [
  {
    name: "submissions",
    sql: `CREATE TABLE IF NOT EXISTS submissions (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      public_id       CHAR(10) UNIQUE NOT NULL,
      tracking_hash   BINARY(32) NOT NULL,
      prompt          TEXT NOT NULL,
      output          TEXT NOT NULL,
      ai_model        VARCHAR(120) NOT NULL,
      summary         TEXT,
      category        VARCHAR(40) NOT NULL,
      author_name     VARCHAR(80),
      submitted_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      status          ENUM('pending','published','rejected','withdrawn') DEFAULT 'pending',
      reviewed_by     INT NULL,
      reviewed_at     DATETIME NULL,
      reviewer_notes  TEXT,
      verified_hits   INT NULL,
      verified_total  INT NULL,
      rejection_reason TEXT,
      ip_hash         BINARY(32),
      INDEX idx_status (status),
      INDEX idx_category (category),
      INDEX idx_model (ai_model)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    name: "tags",
    sql: `CREATE TABLE IF NOT EXISTS tags (
      id    INT AUTO_INCREMENT PRIMARY KEY,
      name  VARCHAR(40) UNIQUE NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    name: "submission_tags",
    sql: `CREATE TABLE IF NOT EXISTS submission_tags (
      submission_id INT NOT NULL,
      tag_id        INT NOT NULL,
      PRIMARY KEY (submission_id, tag_id),
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id)        REFERENCES tags(id)        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    // Unified user accounts. An admin is a user with is_admin=1.
    //
    //   - `password_hash` is nullable: Google-only users have no password.
    //     Passwords are argon2id only (Bun.password.hash).
    //   - `google_sub` is Google's stable subject ID (NOT the email; emails
    //     can be reassigned, sub cannot).
    //   - `email_verified` is set to 1 after a successful 6-digit code
    //     confirmation, or immediately for Google sign-ins (Google verified
    //     the email for us).
    name: "users",
    sql: `CREATE TABLE IF NOT EXISTS users (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      username        VARCHAR(40) UNIQUE NOT NULL,
      email           VARCHAR(254) UNIQUE NOT NULL,
      email_verified  TINYINT(1) NOT NULL DEFAULT 0,
      password_hash   VARCHAR(120) NULL,
      google_sub      VARCHAR(255) UNIQUE NULL,
      is_admin        TINYINT(1) NOT NULL DEFAULT 0,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login_at   DATETIME NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    // Session cookie -> user mapping. Only sha256(token) is stored. A row's
    // existence + non-expired expires_at is what authenticates a request.
    name: "user_sessions",
    sql: `CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash   BINARY(32) PRIMARY KEY,
      user_id      INT NOT NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at   DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_user_expires (user_id, expires_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    // 6-digit email verification codes. One row per outstanding code per user;
    // sending a new one DELETEs the previous row (see auth.ts). `attempts` is
    // a check counter to defeat brute-force of the 6-digit space.
    name: "email_verifications",
    sql: `CREATE TABLE IF NOT EXISTS email_verifications (
      user_id     INT PRIMARY KEY,
      code_hash   BINARY(32) NOT NULL,
      expires_at  DATETIME NOT NULL,
      attempts    INT NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    // Holes in the EAH-number sequence, created when a draft is rejected or
    // withdrawn (OEIS rule: rejected drafts free their A-number for reuse).
    // We pop the MIN(n) before allocating from the high-water mark, so the
    // sequence stays as dense as possible.
    name: "freed_eah_numbers",
    sql: `CREATE TABLE IF NOT EXISTS freed_eah_numbers (
      n INT PRIMARY KEY
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    // Reviewer ↔ submitter chat thread per submission. Visible on:
    //   - /track?code=… (the submitter's view)
    //   - /admin/queue/:id (the staff view)
    //
    // sender_type: 'staff' messages come from an admin (sender_user_id set
    // to a users.id with is_admin=1); 'user' messages come from the submitter
    // authenticated by their tracking code (sender_user_id may be NULL or set
    // if the submitter is a logged-in user). 'system' is reserved for
    // status-change notes posted automatically on accept/reject/withdraw.
    name: "submission_messages",
    sql: `CREATE TABLE IF NOT EXISTS submission_messages (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      submission_id   INT NOT NULL,
      sender_type     ENUM('staff','user','system') NOT NULL,
      sender_user_id  INT NULL,
      body            TEXT NOT NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_submission (submission_id, created_at),
      FOREIGN KEY (submission_id)  REFERENCES submissions(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_user_id) REFERENCES users(id)       ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
];

/**
 * Idempotent column additions. Run AFTER the CREATE TABLE pass.
 * Each entry is `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`; harmless to re-run.
 */
const COLUMN_ADDITIONS: Array<{ table: string; column: string; sql: string }> = [
  {
    table: "submissions",
    column: "notes",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS notes TEXT NULL",
  },
  {
    table: "submissions",
    column: "shared_chat_url",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS shared_chat_url VARCHAR(2048) NULL",
  },
  {
    table: "submissions",
    column: "submitter_email",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS submitter_email VARCHAR(254) NULL",
  },
  {
    // Plaintext copy of the tracking code, ONLY populated when the submitter
    // gave us an email at submit time. With this, /lookup can rebuild
    // /track?code=… links from a single email address. Without it we'd need
    // a second auth surface.
    //
    // Tradeoff: a DB dump now exposes withdrawal codes for email-enabled
    // submissions (it didn't before — tracking codes were hashed-only).
    // Acceptable because (a) withdrawal is reversible by re-submit, (b) the
    // submitter is already trusting us with their email address, which is a
    // strictly more valuable secret than a per-submission revocation code.
    table: "submissions",
    column: "notify_token",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS notify_token VARCHAR(32) NULL",
  },
  {
    table: "submissions",
    column: "staff_review_message",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS staff_review_message TEXT NULL",
  },
  {
    // Speeds up /lookup. CASE-INSENSITIVE — the table's collation is
    // utf8mb4_unicode_ci so lookups are already case-insensitive; we just
    // need the index for performance.
    table: "submissions",
    column: "idx_submitter_email",
    sql: "ALTER TABLE submissions ADD INDEX IF NOT EXISTS idx_submitter_email (submitter_email)",
  },
  // -- A-number system (OEIS-style sequential ID, "A" + 6-digit zero-padded). --
  // Assigned at draft creation; freed back into freed_eah_numbers on reject /
  // withdraw; locked once published.
  {
    table: "submissions",
    column: "eah_number",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS eah_number INT NULL UNIQUE",
  },
  // -- New user-facing fields. --
  {
    table: "submissions",
    column: "title",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS title VARCHAR(200) NULL",
  },
  {
    // Whether the hallucination still reproduces ('active') or has been patched
    // in newer model versions ('patched'). Distinct from the moderation-side
    // submissions.status enum.
    table: "submissions",
    column: "entry_status",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS entry_status ENUM('active','patched') NOT NULL DEFAULT 'active'",
  },
  {
    // When the submitter actually observed the hallucination. Optional —
    // if blank, the submission date is used.
    table: "submissions",
    column: "hallucination_date",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS hallucination_date DATE NULL",
  },
  {
    // Submitter opt-in: if true, the original author keeps direct edit rights
    // post-publication. If false (default), edits require staff approval.
    table: "submissions",
    column: "allow_author_edits",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS allow_author_edits TINYINT(1) NOT NULL DEFAULT 0",
  },
  {
    // Index for "next eah_number" lookups when the freed-numbers pool is empty.
    table: "submissions",
    column: "idx_eah_number",
    sql: "ALTER TABLE submissions ADD INDEX IF NOT EXISTS idx_eah_number (eah_number)",
  },
];

/**
 * Backfill eah_number on rows that don't have one yet. Runs after all schema
 * changes and is itself idempotent.
 *
 * Policy:
 *   - Rows with status 'pending' or 'published' get the next sequential
 *     number, ordered by (submitted_at, id) so the early entries get the
 *     low A-numbers.
 *   - Rows with status 'rejected' or 'withdrawn' get NULL — they didn't
 *     consume an A-number under the new rules, and would consume one
 *     spuriously if we backfilled them now.
 */
async function backfillEahNumbers(): Promise<void> {
  const { query } = await import("../src/db.ts");

  // High-water mark of existing numbers (in case backfill is re-run after some
  // rows already got numbered via the live system).
  const maxRow = await query<{ m: number | null }>(
    "SELECT COALESCE(MAX(eah_number), 0) AS m FROM submissions",
  );
  let next = Number(maxRow[0]?.m ?? 0) + 1;

  const rows = await query<{ id: number }>(
    `SELECT id
       FROM submissions
       WHERE eah_number IS NULL
         AND status IN ('pending', 'published')
       ORDER BY submitted_at ASC, id ASC`,
  );

  if (rows.length === 0) {
    console.log("ok  backfill (no rows needed eah_number)");
    return;
  }

  for (const r of rows) {
    await execute("UPDATE submissions SET eah_number = ? WHERE id = ?", [next, r.id]);
    next++;
  }
  console.log(`ok  backfill (${rows.length} row${rows.length === 1 ? "" : "s"} numbered)`);
}

async function main(): Promise<void> {
  for (const t of TABLES) {
    await execute(t.sql);
    console.log(`ok  ${t.name}`);
  }
  for (const c of COLUMN_ADDITIONS) {
    await execute(c.sql);
    console.log(`ok  ${c.table}.${c.column}`);
  }
  await backfillEahNumbers();
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error("migration failed:", err);
    try {
      await pool.end();
    } catch {}
    process.exit(1);
  });
