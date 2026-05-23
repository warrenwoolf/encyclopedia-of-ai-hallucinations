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
