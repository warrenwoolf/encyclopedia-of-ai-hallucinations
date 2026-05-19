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
    name: "admins",
    sql: `CREATE TABLE IF NOT EXISTS admins (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(40) UNIQUE NOT NULL,
      password_hash VARCHAR(120) NOT NULL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
  {
    name: "admin_sessions",
    sql: `CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash   BINARY(32) PRIMARY KEY,
      admin_id     INT NOT NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at   DATETIME NOT NULL,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  },
];

async function main(): Promise<void> {
  for (const t of TABLES) {
    await execute(t.sql);
    console.log(`ok  ${t.name}`);
  }
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
