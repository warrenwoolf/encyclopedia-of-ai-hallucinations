/**
 * Unit tests for the in-memory token-bucket rate limiter (src/ratelimit.ts).
 *
 * Each test uses a UNIQUE ip string so buckets never interfere across tests.
 */
import { test, expect, describe } from "bun:test";
import { check, gc } from "../src/ratelimit.ts";

describe("check", () => {
  test("unknown action is always allowed (no bucket configured)", () => {
    expect(check("does-not-exist" as any, "ip-unknown").allowed).toBe(true);
  });

  test("allows up to capacity, then blocks with a retry-after", () => {
    const ip = "rl-signup-capacity"; // signup bucket: capacity 5
    for (let i = 0; i < 5; i++) {
      expect(check("signup", ip).allowed).toBe(true);
    }
    const blocked = check("signup", ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  test("separate IPs have independent buckets", () => {
    const a = "rl-iso-a";
    const b = "rl-iso-b";
    for (let i = 0; i < 5; i++) check("signup", a);
    expect(check("signup", a).allowed).toBe(false); // a exhausted
    expect(check("signup", b).allowed).toBe(true); // b untouched
  });

  test("the api bucket allows 20 before blocking", () => {
    const ip = "rl-api-cap";
    for (let i = 0; i < 20; i++) {
      expect(check("api", ip).allowed).toBe(true);
    }
    expect(check("api", ip).allowed).toBe(false);
  });

  test("there is no longer a 'lookup' bucket (removed in the overhaul)", () => {
    // /lookup was removed; its bucket should be gone, so the action is unknown
    // and therefore always allowed (no enforcement). 1000 calls all pass.
    const ip = "rl-lookup-gone";
    for (let i = 0; i < 1000; i++) {
      expect(check("lookup" as any, ip).allowed).toBe(true);
    }
  });
});

describe("gc", () => {
  test("does not throw", () => {
    expect(() => gc()).not.toThrow();
  });
});
