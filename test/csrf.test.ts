/**
 * Unit tests for CSRF protection (src/csrf.ts). All pure — HMAC over the fixed
 * test SESSION_SECRET, no DB.
 */
import { test, expect, describe } from "bun:test";
import { tokenForRequest, verifyCsrf } from "../src/csrf.ts";

function reqWithCookie(cookie?: string): Request {
  return new Request("http://x/", {
    headers: cookie ? { cookie } : {},
  });
}

describe("tokenForRequest", () => {
  test("mints a token and a Set-Cookie when no cookie is present", () => {
    const { token, setCookie } = tokenForRequest(reqWithCookie());
    expect(token).toMatch(/^[a-f0-9]{32}\.\d+\.[a-f0-9]{64}$/);
    expect(setCookie).toContain("eah_csrf=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  test("is memoized per Request object (same token on repeat calls)", () => {
    const req = reqWithCookie();
    const a = tokenForRequest(req);
    const b = tokenForRequest(req);
    expect(a.token).toBe(b.token);
    expect(a).toBe(b); // exact same memoized object
  });

  test("reuses a valid existing cookie token and mints no new cookie", () => {
    const minted = tokenForRequest(reqWithCookie()).token;
    const result = tokenForRequest(reqWithCookie(`eah_csrf=${minted}`));
    expect(result.token).toBe(minted);
    expect(result.setCookie).toBeNull();
  });

  test("replaces a malformed cookie token", () => {
    const result = tokenForRequest(reqWithCookie("eah_csrf=not-a-valid-token"));
    expect(result.token).not.toBe("not-a-valid-token");
    expect(result.setCookie).not.toBeNull();
  });
});

describe("verifyCsrf", () => {
  test("accepts a request whose cookie and form field match a valid token", () => {
    const token = tokenForRequest(reqWithCookie()).token;
    const req = reqWithCookie(`eah_csrf=${token}`);
    expect(verifyCsrf(req, token)).toBe(true);
  });

  test("rejects when the form token is missing", () => {
    const token = tokenForRequest(reqWithCookie()).token;
    const req = reqWithCookie(`eah_csrf=${token}`);
    expect(verifyCsrf(req, null)).toBe(false);
    expect(verifyCsrf(req, undefined)).toBe(false);
    expect(verifyCsrf(req, "")).toBe(false);
  });

  test("rejects when there is no cookie at all", () => {
    const token = tokenForRequest(reqWithCookie()).token;
    expect(verifyCsrf(reqWithCookie(), token)).toBe(false);
  });

  test("rejects when cookie and form token differ", () => {
    const t1 = tokenForRequest(reqWithCookie()).token;
    const t2 = tokenForRequest(reqWithCookie("eah_csrf=garbage")).token;
    const req = reqWithCookie(`eah_csrf=${t1}`);
    expect(verifyCsrf(req, t2)).toBe(false);
  });

  test("rejects a token with a tampered HMAC", () => {
    const token = tokenForRequest(reqWithCookie()).token;
    const parts = token.split(".");
    // Flip the last hex char of the signature.
    const lastChar = parts[2]!.slice(-1);
    parts[2] = parts[2]!.slice(0, -1) + (lastChar === "0" ? "1" : "0");
    const forged = parts.join(".");
    const req = reqWithCookie(`eah_csrf=${forged}`);
    expect(verifyCsrf(req, forged)).toBe(false);
  });

  test("rejects an expired token", () => {
    // Hand-craft a token shaped correctly but with a past expiry. Because the
    // HMAC won't match (we don't sign it), this is rejected for two reasons;
    // either way verifyCsrf must return false.
    const expired = "0".repeat(32) + "." + "1000" + "." + "0".repeat(64);
    const req = reqWithCookie(`eah_csrf=${expired}`);
    expect(verifyCsrf(req, expired)).toBe(false);
  });
});
