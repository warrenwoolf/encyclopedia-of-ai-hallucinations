/**
 * Seeds the first admin row from ADMIN_BOOTSTRAP_USER / ADMIN_BOOTSTRAP_PASS.
 * Idempotent: if the username already exists, exits 0 without changes.
 *
 * Usage: `bun run scripts/seed-admin.ts`
 */
import { config } from "../src/config.ts";
import { execute, pool } from "../src/db.ts";
import { hashPassword } from "../src/auth.ts";

const USERNAME_RE = /^[A-Za-z0-9_.]{3,40}$/;
const MIN_PASSWORD_LEN = 10;

// MariaDB / MySQL duplicate-entry error code.
const ER_DUP_ENTRY = 1062;

interface MariaError {
  errno?: number;
  code?: string;
}

function isDuplicateKey(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as MariaError;
  return e.errno === ER_DUP_ENTRY || e.code === "ER_DUP_ENTRY";
}

async function main(): Promise<number> {
  const user = config.adminBootstrap.user;
  const pass = config.adminBootstrap.pass;

  if (!user || !pass) {
    console.error(
      "error: ADMIN_BOOTSTRAP_USER and ADMIN_BOOTSTRAP_PASS must both be set",
    );
    return 1;
  }

  if (!USERNAME_RE.test(user)) {
    console.error(
      "error: username must be 3-40 chars of ASCII letters, digits, underscore, or dot",
    );
    return 1;
  }

  if (pass.length < MIN_PASSWORD_LEN) {
    console.error(`error: password must be at least ${MIN_PASSWORD_LEN} characters`);
    return 1;
  }

  const passwordHash = await hashPassword(pass);

  try {
    await execute(
      "INSERT INTO admins (username, password_hash) VALUES (?, ?)",
      [user, passwordHash],
    );
    console.log(`created admin ${user}`);
    return 0;
  } catch (err: unknown) {
    if (isDuplicateKey(err)) {
      console.log("admin already exists, doing nothing");
      return 0;
    }
    console.error("seed-admin failed:", err);
    return 1;
  }
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
