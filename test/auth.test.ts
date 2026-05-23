/**
 * Unit tests for the non-DB parts of src/auth.ts: password hashing, cookie
 * parsing, and the HMAC-signed pending-verify cookie.
 *
 * Session creation / verification-code consumption need a real DB and are not
 * covered here (they belong in an integration suite with a test MariaDB).
 */
import { test, expect, describe } from "bun:test";
import {
  hashPassword,
  verifyPassword,
  parseCookie,
  encodePendingVerifyCookie,
  decodePendingVerifyCookie,
  clearSessionCookie,
  clearPendingVerifyCookie,
} from "../src/auth.ts";

describe("hashPassword / verifyPassword", () => {
  test("produces an argon2id hash that verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  test("rejects the wrong password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword("hunter3", hash)).toBe(false);
  });

  test("rejects non-argon2 hashes (no bcrypt fallback)", async () => {
    // A bcrypt-shaped hash must never verify.
    const bcryptish = "$2b$12$abcdefghijklmnopqrstuv";
    expect(await verifyPassword("anything", bcryptish)).toBe(false);
  });

  test("returns false on empty hash without throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
  });
});

describe("parseCookie", () => {
  test("extracts a named cookie value", () => {
    expect(parseCookie("a=1; b=2; c=3", "b")).toBe("2");
  });

  test("URL-decodes the value", () => {
    expect(parseCookie("x=hello%20world", "x")).toBe("hello world");
  });

  test("returns undefined for an absent cookie", () => {
    expect(parseCookie("a=1", "b")).toBeUndefined();
  });
});

describe("pending-verify cookie", () => {
  function cookieValue(setCookie: string): string {
    // "eah_pending_verify=<value>; HttpOnly; ..." → "<value>"
    return setCookie.split(";")[0]!.split("=").slice(1).join("=");
  }

  function reqWith(value: string): Request {
    return new Request("http://x/verify", {
      headers: { cookie: `eah_pending_verify=${value}` },
    });
  }

  test("round-trips the userId", () => {
    const setCookie = encodePendingVerifyCookie(4242);
    expect(setCookie).toContain("Path=/verify");
    const decoded = decodePendingVerifyCookie(reqWith(cookieValue(setCookie)));
    expect(decoded).toEqual({ userId: 4242 });
  });

  test("rejects a tampered userId (HMAC mismatch)", () => {
    const value = cookieValue(encodePendingVerifyCookie(1));
    const parts = value.split(".");
    parts[0] = "9999"; // change the userId but keep the old signature
    const decoded = decodePendingVerifyCookie(reqWith(parts.join(".")));
    expect(decoded).toBeNull();
  });

  test("rejects a malformed cookie", () => {
    expect(decodePendingVerifyCookie(reqWith("not.valid"))).toBeNull();
  });

  test("returns null when the cookie is absent", () => {
    expect(decodePendingVerifyCookie(new Request("http://x/verify"))).toBeNull();
  });
});

describe("cookie-clearing helpers", () => {
  test("clearSessionCookie expires the session cookie", () => {
    const c = clearSessionCookie();
    expect(c).toContain("eah_session=");
    expect(c).toContain("Max-Age=0");
  });

  test("clearPendingVerifyCookie is scoped to /verify and expires", () => {
    const c = clearPendingVerifyCookie();
    expect(c).toContain("eah_pending_verify=");
    expect(c).toContain("Path=/verify");
    expect(c).toContain("Max-Age=0");
  });
});
