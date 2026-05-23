/**
 * Tests for src/config.ts.
 *
 * NOTE: the test preload (test/setup.ts) sets PUBLIC_BASE_URL to
 * "http://localhost:8090" and leaves GOOGLE_CLIENT_ID empty.
 */
import { test, expect, describe } from "bun:test";
import { config } from "../src/config.ts";

describe("googleOAuth", () => {
  test("exposes only a client id (no secret, no redirect URI)", () => {
    // The GIS embedded flow needs only a client id: verification is local
    // against Google's JWKS, so there is no server-side code exchange and
    // therefore no client secret and no redirect/callback URI.
    //
    // NOTE: we assert the SHAPE, not the value. test/oauth-google.test.ts
    // installs a global mock.module for ../src/config.ts to give clientId a
    // value; mock.module live-bindings can bleed across files, so asserting
    // clientId === "" here would be order-dependent and flaky.
    expect(typeof config.googleOAuth.clientId).toBe("string");
    expect(Object.keys(config.googleOAuth)).toEqual(["clientId"]);
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
