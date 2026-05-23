/**
 * Tests for src/config.ts — primarily documenting how the Google OAuth
 * redirect URI is derived, since that's what must be whitelisted in the
 * Google Cloud Console.
 *
 * NOTE: the test preload (test/setup.ts) sets PUBLIC_BASE_URL to
 * "http://localhost:8090" and leaves GOOGLE_REDIRECT_URI unset.
 */
import { test, expect, describe } from "bun:test";
import { config } from "../src/config.ts";

describe("googleOAuth.redirectUri", () => {
  test("defaults to <PUBLIC_BASE_URL>/oauth/google/callback", () => {
    // This is the exact string that must be added to "Authorized redirect URIs"
    // in the Google Cloud Console for local development.
    expect(config.googleOAuth.redirectUri).toBe(
      "http://localhost:8090/oauth/google/callback",
    );
  });

  test("always ends with the canonical callback path", () => {
    expect(config.googleOAuth.redirectUri.endsWith("/oauth/google/callback")).toBe(true);
  });
});

describe("config basics", () => {
  test("default port is 8090", () => {
    expect(config.port).toBe(8090);
  });

  test("email monthly cap is a number", () => {
    expect(typeof config.email.monthlyCap).toBe("number");
  });
});
