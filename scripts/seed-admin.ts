/**
 * Upserts the bootstrap admin from ADMIN_BOOTSTRAP_USER / _EMAIL / _PASS.
 *
 * Re-running is safe: if a user with the same username exists, it's updated
 * in place (email + password). After running scripts/drop-legacy.ts, the
 * legacy `admins` table is gone — this script writes only to `users`.
 *
 * Usage: `bun run scripts/seed-admin.ts`
 */
import { config } from "../src/config.ts";
import { pool, transaction } from "../src/db.ts";
import { hashPassword } from "../src/auth.ts";

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 10;

async function main(): Promise<number> {
  const user = config.adminBootstrap.user.trim();
  const email = config.adminBootstrap.email.trim().toLowerCase();
  const pass = config.adminBootstrap.pass;

  if (!user || !pass || !email) {
    console.error(
      "error: ADMIN_BOOTSTRAP_USER, ADMIN_BOOTSTRAP_EMAIL, and " +
        "ADMIN_BOOTSTRAP_PASS must all be set",
    );
    return 1;
  }
  if (!USERNAME_RE.test(user)) {
    console.error(
      "error: username must be 3-40 chars of ASCII letters, digits, underscore, dot, or hyphen",
    );
    return 1;
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    console.error("error: ADMIN_BOOTSTRAP_EMAIL must be a valid email address");
    return 1;
  }
  if (pass.length < MIN_PASSWORD_LEN) {
    console.error(`error: password must be at least ${MIN_PASSWORD_LEN} characters`);
    return 1;
  }

  const passwordHash = await hashPassword(pass);

  await transaction(async (tx) => {
    const existing = await tx.queryOne<{ id: number }>(
      "SELECT id FROM users WHERE username = ? LIMIT 1",
      [user],
    );

    if (existing) {
      // Make sure the new email isn't on a different user.
      const conflict = await tx.queryOne<{ id: number }>(
        "SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id <> ? LIMIT 1",
        [email, existing.id],
      );
      if (conflict) {
        throw new Error(`email ${email} is already used by another user`);
      }
      await tx.execute(
        `UPDATE users
           SET email = ?, email_verified = 1, password_hash = ?, is_admin = 1
         WHERE id = ?`,
        [email, passwordHash, existing.id],
      );
      console.log(`updated admin ${user} (id=${existing.id})`);
    } else {
      const emailConflict = await tx.queryOne<{ id: number }>(
        "SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
        [email],
      );
      if (emailConflict) {
        throw new Error(`email ${email} is already used by user id=${emailConflict.id}`);
      }
      const ins = await tx.execute(
        `INSERT INTO users (username, email, email_verified, password_hash, is_admin)
         VALUES (?, ?, 1, ?, 1)`,
        [user, email, passwordHash],
      );
      console.log(`created admin ${user} (id=${ins.insertId})`);
    }
  });

  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error("seed-admin failed:", err);
    try {
      await pool.end();
    } catch {}
    process.exit(1);
  });
