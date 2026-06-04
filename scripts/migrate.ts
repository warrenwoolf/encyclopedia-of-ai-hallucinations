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
    // Multi-turn conversation rows. A submission with transcript_mode in
    // ('turns','block') stores its conversation here, one row per turn, ordered
    // by turn_index (0-based). 'single' (legacy) submissions have NO rows here
    // and keep using submissions.prompt / submissions.output. MEDIUMTEXT so a
    // single long turn isn't truncated. Must appear AFTER submissions so the FK
    // resolves.
    name: "submission_turns",
    sql: `CREATE TABLE IF NOT EXISTS submission_turns (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      submission_id   INT NOT NULL,
      turn_index      INT NOT NULL,
      role            ENUM('user','assistant') NOT NULL,
      content         MEDIUMTEXT NOT NULL,
      INDEX idx_sub_turn (submission_id, turn_index),
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    // Hallucination categories. Seeded with DEFAULT_CATEGORIES (see
    // seedCategories below) and extendable at runtime by staff via
    // /admin/categories. `key` is the stable slug stored on submissions.category;
    // `id` gives a stable display order (defaults first, then staff additions).
    name: "categories",
    sql: `CREATE TABLE IF NOT EXISTS categories (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      \`key\`        VARCHAR(40) UNIQUE NOT NULL,
      label        VARCHAR(120) NOT NULL,
      description  TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
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
  {
    // Audit log of field-by-field diffs on user-owned draft submissions.
    // Grouped by version_num (all fields changed in a single edit share the
    // same version_num). version_num is scoped per submission_id. Rows are
    // inserted by src/versions.ts → recordVersionDiffs(), which must be called
    // inside the same transaction as the UPDATE on submissions so the snapshot
    // is consistent.
    //
    // Must appear AFTER submissions and users in TABLES so FK resolution works.
    name: "submission_versions",
    sql: `CREATE TABLE IF NOT EXISTS submission_versions (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      submission_id   INT NOT NULL,
      version_num     INT NOT NULL,
      changed_by      INT NULL,
      changed_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      field_name      VARCHAR(60) NOT NULL,
      old_value       MEDIUMTEXT,
      new_value       MEDIUMTEXT,
      INDEX idx_sub_ver (submission_id, version_num),
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by)    REFERENCES users(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    // Visitor-reported complaints about a published entry (POST /e/:id/complaint).
    // Anyone — logged in or not — can file one; reporter_user_id is the account
    // id when present, NULL for anonymous reporters. complaint_type is a small
    // hardcoded enum (see COMPLAINT_TYPES in src/routes/complaint.ts), stored as
    // a VARCHAR so the set can grow without a schema migration. ip_hash mirrors
    // submissions.ip_hash (sha256(SESSION_SECRET || ip)) — no raw IPs.
    //
    // Must appear AFTER submissions and users in TABLES so FK resolution works.
    name: "complaints",
    sql: `CREATE TABLE IF NOT EXISTS complaints (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      submission_id    INT NOT NULL,
      reporter_user_id INT NULL,
      complaint_type   VARCHAR(40) NOT NULL,
      body             TEXT NOT NULL,
      status           ENUM('open','resolved','dismissed') NOT NULL DEFAULT 'open',
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_hash          BINARY(32) NULL,
      INDEX idx_submission (submission_id),
      INDEX idx_status (status),
      FOREIGN KEY (submission_id)    REFERENCES submissions(id) ON DELETE CASCADE,
      FOREIGN KEY (reporter_user_id) REFERENCES users(id)       ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    // Owner-tunable key/value site configuration. Currently holds just
    // `repro_threshold` (the number of distinct staff confirmations required to
    // accept/reject a pending-acceptance entry's reproduction). Read into an
    // in-memory cache by src/settings.ts at boot; edited via /admin/settings
    // (owner-only). `key` is a reserved word, hence the backticks.
    name: "site_settings",
    sql: `CREATE TABLE IF NOT EXISTS site_settings (
      \`key\`   VARCHAR(64) PRIMARY KEY,
      value   VARCHAR(255) NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    // Staff/owner votes on whether a pending-acceptance entry reproduces. One
    // row per (submission, reviewer); `vote` is their current choice. A single
    // owner vote is decisive; otherwise the first action (reproduce vs fail) to
    // collect `repro_threshold` distinct staff votes wins (see review.ts).
    // CASCADE on both FKs: votes are meaningless once the submission or the
    // voter is gone. Must appear AFTER submissions and users so the FKs resolve.
    name: "repro_votes",
    sql: `CREATE TABLE IF NOT EXISTS repro_votes (
      submission_id INT NOT NULL,
      user_id       INT NOT NULL,
      vote          ENUM('reproduce','fail') NOT NULL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (submission_id, user_id),
      INDEX idx_sub_vote (submission_id, vote),
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)       REFERENCES users(id)       ON DELETE CASCADE
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
  // Assigned only when a reviewed entry is marked 'reproduced' (the canonical
  // tier); freed back into freed_eah_numbers if it's later demoted; retired (not
  // recycled) when a reproduced entry is owner-deleted. See src/eah-id.ts.
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
    // Submitter opt-in: if true (1), EAH staff may edit this submission even
    // though they don't own it (e.g. fix typos, add reproduction notes). If
    // false (0, default), staff cannot edit someone else's submission. The
    // owner can always edit their own; owners (is_owner=1) can edit anything.
    table: "submissions",
    column: "allow_author_edits",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS allow_author_edits TINYINT(1) NOT NULL DEFAULT 0",
  },
  {
    // Public anonymity opt-in. 0 (default) = the submitter's account username
    // is shown publicly as the author. 1 = the public entry shows "anonymous"
    // and only staff can see which account submitted it. Replaces the old
    // free-text author_name field for account submissions (author_name is kept
    // for legacy rows and staff-created direct entries that have no owner).
    table: "submissions",
    column: "anon_public",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS anon_public TINYINT(1) NOT NULL DEFAULT 0",
  },
  {
    // Conversation shape. 'single' (default) = legacy one-shot prompt/output
    // stored in submissions.prompt / output, no submission_turns rows. 'turns'
    // / 'block' = a multi-turn conversation whose turns live in submission_turns
    // (prompt/output still mirror the first user/assistant turn for search +
    // the NOT NULL constraint). Existing rows default to 'single' and render
    // unchanged with no data migration. See src/turns.ts.
    table: "submissions",
    column: "transcript_mode",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS transcript_mode ENUM('single','turns','block') NOT NULL DEFAULT 'single'",
  },
  {
    // Index for "next eah_number" lookups when the freed-numbers pool is empty.
    table: "submissions",
    column: "idx_eah_number",
    sql: "ALTER TABLE submissions ADD INDEX IF NOT EXISTS idx_eah_number (eah_number)",
  },
  // ── Draft-overhaul additions (Bug L fix) ─────────────────────────────────────
  // submit.ts, my.ts, and versions.ts depend on these. Without them the draft
  // workflow and even anonymous submit fail against a freshly-migrated DB.
  {
    // Links a logged-in user's draft to their account. NULL for anonymous
    // submissions. SET NULL on user deletion so the submission outlives the
    // account (an admin can still review/publish it).
    table: "submissions",
    column: "owner_user_id",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS owner_user_id INT NULL",
  },
  {
    // FK must be a separate ALTER because MariaDB's ADD COLUMN IF NOT EXISTS
    // does not support an inline REFERENCES clause. ADD FOREIGN KEY IF NOT
    // EXISTS is the idempotent form (ADD CONSTRAINT IF NOT EXISTS is not
    // supported in MariaDB 11.4 for FOREIGN KEY).
    table: "submissions",
    column: "fk_sub_owner",
    sql: "ALTER TABLE submissions ADD FOREIGN KEY IF NOT EXISTS fk_sub_owner (owner_user_id) REFERENCES users(id) ON DELETE SET NULL",
  },
  {
    // Speeds up /my/submissions queries that filter by owner_user_id.
    table: "submissions",
    column: "idx_owner",
    sql: "ALTER TABLE submissions ADD INDEX IF NOT EXISTS idx_owner (owner_user_id)",
  },
  {
    // Staff "time out" a user by setting suspended_until to a future datetime.
    // A suspended user can still log in and browse — they just can't submit or
    // propose submissions for review until the window passes (see submit.ts).
    // NULL (the default) = not suspended. Past values are harmless: the
    // comparison is against NOW() each request.
    table: "users",
    column: "suspended_until",
    sql: "ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until DATETIME NULL",
  },
  {
    // Free-text reason a staffer wrote when timing a user out. Shown to the
    // user on the submit page so they know why they can't submit. NULL = none.
    table: "users",
    column: "suspended_reason",
    sql: "ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT NULL",
  },
  {
    // Owner role. Owners have ALL privileges, including managing accounts and
    // adding/removing other owners; staff (is_admin=1) can only manage the
    // submission queue, not accounts. Bootstrap the first owner by hand:
    //   UPDATE users SET is_owner = 1 WHERE username = '...';
    table: "users",
    column: "is_owner",
    sql: "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner TINYINT(1) NOT NULL DEFAULT 0",
  },
  // ── Tiered-lifecycle overhaul (iNaturalist-style trust ladder) ───────────────
  // The moderation axis becomes draft → unreviewed → reviewed (→ rejected). A
  // second orthogonal axis, repro_status, records the staff reproduction outcome
  // and is only meaningful once status='reviewed'. The legacy 'pending'/'published'
  // values are kept in the enum so migrateStatusTiers() (run below) can read and
  // rewrite existing rows; no live row references them afterwards.
  {
    // Reproduction outcome. Only meaningful when status='reviewed':
    //   pending    — reviewed, reproduction not yet attempted (also the resting
    //                state for link/social-media submissions, which can't be
    //                reproduced).
    //   reproduced — staff reproduced the behavior. THIS is the tier that earns
    //                a canonical A-number (see src/eah-id.ts).
    //   failed     — staff tried and could not reproduce it (kept, labeled).
    table: "submissions",
    column: "repro_status",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS repro_status ENUM('pending','reproduced','failed') NOT NULL DEFAULT 'pending'",
  },
  {
    // Link to a third-party post (Reddit/X/etc.) for 'link' transcript_mode
    // submissions. The pasted failure text lives in `summary` so the entry
    // survives link rot; this is just the citation back to the original.
    table: "submissions",
    column: "source_url",
    sql: "ALTER TABLE submissions ADD COLUMN IF NOT EXISTS source_url VARCHAR(2048) NULL",
  },
  {
    // Extend the moderation enum to the tiered set. Adding values is in-place in
    // MariaDB. Default stays 'draft' (the safe/private default): submit.ts sets
    // 'unreviewed' explicitly on the submit-for-review path.
    table: "submissions",
    column: "status_with_tiers",
    sql: "ALTER TABLE submissions MODIFY COLUMN status ENUM('draft','unreviewed','reviewed','rejected','withdrawn','pending','published') NOT NULL DEFAULT 'draft'",
  },
  {
    // Add 'link' to the transcript shape enum (link/social-media submissions).
    table: "submissions",
    column: "transcript_mode_link",
    sql: "ALTER TABLE submissions MODIFY COLUMN transcript_mode ENUM('single','turns','block','link') NOT NULL DEFAULT 'single'",
  },
  {
    table: "submissions",
    column: "idx_repro_status",
    sql: "ALTER TABLE submissions ADD INDEX IF NOT EXISTS idx_repro_status (repro_status)",
  },
];

/**
 * One-shot, idempotent migration of legacy moderation statuses onto the tiered
 * lifecycle. Guarded so re-runs are no-ops (no live row stays 'pending'/'published',
 * and number-freeing only touches rows that still wrongly hold a number).
 *
 * Mapping:
 *   published          → reviewed + repro_status='reproduced'  (grandfather the
 *                        canon; KEEP their A-numbers)
 *   pending            → unreviewed                            (free A-number)
 *   withdrawn          → draft                                 (free A-number)
 *   draft (legacy)     → draft                                 (free A-number —
 *                        drafts no longer hold numbers)
 *   rejected           → unchanged (already number-free)
 *
 * Freeing = NULL the number and return it to freed_eah_numbers, so the pool can
 * recycle it for the next entry that reaches 'reproduced'.
 */
async function migrateStatusTiers(): Promise<void> {
  const { query } = await import("../src/db.ts");

  // Return to the pool every number held by a row that shouldn't keep one under
  // the new rules: anything not published and not already-reviewed. Do this
  // BEFORE the status rewrite so the WHERE still sees legacy values. Idempotent:
  // once NULLed, the row no longer matches.
  const toFree = await query<{ eah_number: number }>(
    `SELECT eah_number FROM submissions
       WHERE eah_number IS NOT NULL
         AND status IN ('pending', 'draft', 'withdrawn')`,
  );
  for (const r of toFree) {
    await execute("INSERT IGNORE INTO freed_eah_numbers (n) VALUES (?)", [r.eah_number]);
  }
  await execute(
    `UPDATE submissions SET eah_number = NULL
       WHERE eah_number IS NOT NULL
         AND status IN ('pending', 'draft', 'withdrawn')`,
  );

  // Status rewrite. published carries its number into the reproduced canon.
  const pub = await execute(
    "UPDATE submissions SET status = 'reviewed', repro_status = 'reproduced' WHERE status = 'published'",
  );
  const pend = await execute("UPDATE submissions SET status = 'unreviewed' WHERE status = 'pending'");
  const wd = await execute("UPDATE submissions SET status = 'draft' WHERE status = 'withdrawn'");

  console.log(
    `ok  status tiers (published→reproduced: ${pub.affectedRows}, ` +
      `pending→unreviewed: ${pend.affectedRows}, withdrawn→draft: ${wd.affectedRows}, ` +
      `numbers freed: ${toFree.length})`,
  );
}

/**
 * Backfill eah_number on canonical rows that somehow lack one. Runs after the
 * tier migration and is itself idempotent.
 *
 * Policy: only reviewed + reproduced rows (the canonical tier) carry an A-number.
 * Any such row missing one gets the next sequential number, ordered by
 * (submitted_at, id) so the earliest entries get the low A-numbers. Every other
 * tier is intentionally number-free.
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
         AND status = 'reviewed'
         AND repro_status = 'reproduced'
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

/**
 * Seed the `categories` table with DEFAULT_CATEGORIES. Idempotent: INSERT
 * IGNORE skips any key that already exists, so re-running never clobbers
 * staff-added categories or edits. Only seeds the built-in defaults.
 */
async function seedCategories(): Promise<void> {
  const { DEFAULT_CATEGORIES } = await import("../src/categories.ts");
  for (const c of DEFAULT_CATEGORIES) {
    await execute(
      "INSERT IGNORE INTO categories (`key`, label, description) VALUES (?, ?, ?)",
      [c.key, c.label, c.description],
    );
  }
  // Targeted relabel: "Spiraling / Looping" → "Spiraling / Looping / Thrashing"
  // ("Thrashing" is the more standard term). Idempotent and only touches a row
  // still carrying the exact old default label, so it never clobbers a staff
  // edit or re-applies once renamed.
  await execute(
    "UPDATE categories SET label = ? WHERE `key` = 'spiraling' AND label = 'Spiraling / Looping'",
    ["Spiraling / Looping / Thrashing"],
  );
  // Title-case relabels: the original defaults were sentence-case ("Factual
  // error"); they read better as title-case ("Factual Error"). Same idempotent
  // pattern — each UPDATE only fires on a row still carrying the exact old
  // default label, so staff edits are never clobbered and re-runs are no-ops.
  const titleCaseRelabels: Array<[key: string, oldLabel: string, newLabel: string]> = [
    ["tokenization", "Tokenization / Letter-counting", "Tokenization / Letter-Counting"],
    ["fabricated-citation", "Fabricated citation", "Fabricated Citation"],
    ["fake-code-api", "Fake code / API", "Fake Code / API"],
    ["factual-error", "Factual error", "Factual Error"],
    ["temporal", "Temporal confusion", "Temporal Confusion"],
    ["instruction-following", "Instruction-following failure", "Instruction-Following Failure"],
  ];
  for (const [key, oldLabel, newLabel] of titleCaseRelabels) {
    await execute(
      "UPDATE categories SET label = ? WHERE `key` = ? AND label = ?",
      [newLabel, key, oldLabel],
    );
  }
  console.log(`ok  seed categories (${DEFAULT_CATEGORIES.length} defaults)`);
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
  await seedCategories();
  await migrateStatusTiers();
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
