/**
 * Unit tests for src/routes/types.ts — sanitizeText (Trojan-source / control
 * char scrub) and parseForm (size-capped urlencoded body parser).
 */
import { test, expect, describe } from "bun:test";
import { sanitizeText, parseForm, htmlResponse } from "../src/routes/types.ts";

describe("sanitizeText", () => {
  test("keeps ordinary text untouched", () => {
    expect(sanitizeText("Hello, world! 123")).toBe("Hello, world! 123");
  });

  test("preserves tab, newline, carriage return", () => {
    expect(sanitizeText("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  test("strips C0 control characters (except tab/LF/CR)", () => {
    expect(sanitizeText("a\x00b\x07c\x1Fd")).toBe("abcd");
  });

  test("strips DEL and C1 controls", () => {
    expect(sanitizeText("a\x7Fb\x9Fc")).toBe("abc");
  });

  test("strips BiDi overrides + isolates (Trojan Source)", () => {
    // U+202A..U+202E and U+2066..U+2069
    const bidi = "‪‫‬‭‮⁦⁧⁨⁩";
    expect(sanitizeText(`safe${bidi}evil`)).toBe("safeevil");
  });

  test("strips zero-width characters and BOM", () => {
    // ZWSP, ZWNJ, ZWJ, LRM, RLM, BOM
    const zw = "​‌‍‎‏﻿";
    expect(sanitizeText(`a${zw}b`)).toBe("ab");
  });

  test("preserves legitimate non-ASCII (accents, CJK, emoji)", () => {
    const s = "café 日本語 \u{1F353}";
    expect(sanitizeText(s)).toBe(s);
  });
});

describe("parseForm", () => {
  function urlencodedRequest(body: string): Request {
    return new Request("http://x/submit", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  test("parses urlencoded body into URLSearchParams", async () => {
    const params = await parseForm(urlencodedRequest("a=1&b=hello+world&b=2"));
    expect(params.get("a")).toBe("1");
    expect(params.get("b")).toBe("hello world");
    expect(params.getAll("b")).toEqual(["hello world", "2"]);
  });

  test("rejects a body whose Content-Length exceeds the cap", async () => {
    const req = new Request("http://x/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": "999999",
      },
      body: "a=1",
    });
    await expect(parseForm(req, 1024)).rejects.toThrow(/too large/);
  });

  test("aborts when the streamed body exceeds the cap (lying/absent length)", async () => {
    const big = "a=" + "x".repeat(5000);
    await expect(parseForm(urlencodedRequest(big), 1024)).rejects.toThrow(/too large/);
  });

  test("an empty body yields empty params", async () => {
    const params = await parseForm(urlencodedRequest(""));
    expect([...params.keys()]).toEqual([]);
  });
});

describe("htmlResponse", () => {
  test("sets the HTML content type and default 200 status", () => {
    const res = htmlResponse("<p>x</p>");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  test("honors a custom status and Set-Cookie", () => {
    const res = htmlResponse("<p>x</p>", { status: 404, setCookie: "k=v" });
    expect(res.status).toBe(404);
    expect(res.headers.get("Set-Cookie")).toBe("k=v");
  });
});
