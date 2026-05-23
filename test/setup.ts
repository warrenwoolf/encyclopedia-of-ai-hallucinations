/**
 * Test preload (configured in bunfig.toml `[test].preload`).
 *
 * `src/config.ts` calls required() for DB_USER / DB_PASSWORD / DB_NAME /
 * SESSION_SECRET at module-eval time and throws if any are missing. Since
 * almost every module transitively imports config.ts, we must set these
 * BEFORE any test file (and therefore any `src/` module) is evaluated. A
 * preload script is the only place that reliably runs first.
 *
 * These are throwaway values: the unit tests here never open a real DB
 * connection (DB-touching handlers are exercised with a mocked `src/db.ts`).
 * SESSION_SECRET is fixed so HMAC-signed tokens (CSRF, pending-verify) are
 * deterministic within a run.
 */

function setDefault(name: string, value: string): void {
  if (!process.env[name] || process.env[name]!.length === 0) {
    process.env[name] = value;
  }
}

setDefault("DB_USER", "test");
setDefault("DB_PASSWORD", "test");
setDefault("DB_NAME", "eah_test");
setDefault("SESSION_SECRET", "test-secret-0123456789abcdef0123456789abcdef");

// Used by the OAuth-redirect and feed/url tests. Fixed so assertions are stable.
setDefault("PUBLIC_BASE_URL", "http://localhost:8090");

// Keep email + OAuth disabled so nothing tries to hit the network on import.
setDefault("RESEND_API_KEY", "");
setDefault("GOOGLE_CLIENT_ID", "");
setDefault("GOOGLE_CLIENT_SECRET", "");

// ── Integration DB (opt-in) ───────────────────────────────────────────────────
//
// When EAH_TEST_DB=1, spin up a throwaway MariaDB in Docker, point the DB_* env
// at it, and apply the real schema by running scripts/migrate.ts against it.
// This MUST happen here in the preload — before any test file (and therefore
// src/db.ts, which builds its pool from env at import time) is evaluated — so
// the pool connects to the container rather than the dummy values above.
//
//   EAH_TEST_DB=1 bun test test/integration/
//
// A plain `bun test` leaves this untouched and stays fully Docker-free.
//
// We drive Docker through its CLI rather than the `testcontainers` npm package:
// that library's readiness-wait machinery (dockerode log/exec streaming) hangs
// under Bun — the container starts but `.start()` never returns. The CLI path
// is reliable and keeps the harness dependency-free. The integration suite's
// afterAll removes the container (see test/integration/harness.ts → stopTestDb).
if (process.env.EAH_TEST_DB === "1") {
  const log = (m: string) => process.stderr.write(`[test-setup] ${m}\n`);

  async function sh(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code: await p.exited, stdout, stderr };
  }

  const IMAGE = process.env.EAH_TEST_DB_IMAGE ?? "mariadb:11.4";
  const name = `eah-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  log(`starting MariaDB (${IMAGE}) as ${name}…`);
  const run = await sh([
    "docker", "run", "-d", "--name", name,
    "-e", "MARIADB_DATABASE=eah_test",
    "-e", "MARIADB_USER=eah",
    "-e", "MARIADB_PASSWORD=eah",
    "-e", "MARIADB_ROOT_PASSWORD=root",
    "-p", "127.0.0.1::3306", // bind a random free host port on loopback
    IMAGE,
  ]);
  if (run.code !== 0) {
    throw new Error(`[test] docker run failed: ${run.stderr || run.stdout}`);
  }

  // Record the name immediately so teardown can remove it even if readiness or
  // migration fails below.
  (globalThis as Record<string, unknown>).__EAH_TEST_DB_CONTAINER = name;

  // Resolve the mapped host port (output looks like "127.0.0.1:49153").
  const portOut = (await sh(["docker", "port", name, "3306/tcp"])).stdout;
  const portMatch = portOut.match(/:(\d+)\s*$/m);
  if (!portMatch) throw new Error(`[test] could not parse mapped port from: ${portOut}`);
  const port = portMatch[1]!;

  // Poll readiness with mariadb-admin ping (typically ready in a few seconds).
  let ready = false;
  for (let i = 0; i < 80; i++) {
    const ping = await sh(["docker", "exec", name, "mariadb-admin", "ping", "-ueah", "-peah", "--silent"]);
    if (ping.code === 0) { ready = true; break; }
    await Bun.sleep(500);
  }
  if (!ready) throw new Error("[test] MariaDB did not become ready within 40s");

  process.env.DB_HOST = "127.0.0.1";
  process.env.DB_PORT = port;
  process.env.DB_USER = "eah";
  process.env.DB_PASSWORD = "eah";
  process.env.DB_NAME = "eah_test";
  log(`MariaDB ready on 127.0.0.1:${port}`);

  // Apply the real schema exactly as production would: run migrate.ts as a
  // subprocess (it calls process.exit(), so we must NOT import it in-process).
  log("running scripts/migrate.ts…");
  const migrate = Bun.spawn(["bun", "scripts/migrate.ts"], {
    env: { ...process.env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await migrate.exited;
  if (code !== 0) throw new Error(`[test] scripts/migrate.ts failed (exit ${code})`);
  log("schema migrated");
}
