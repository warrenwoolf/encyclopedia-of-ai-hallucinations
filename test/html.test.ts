/**
 * Unit tests for the XSS-safe HTML escaper (src/html.ts). This is THE chokepoint
 * for output safety, so it gets thorough coverage.
 */
import { test, expect, describe } from "bun:test";
import { escape, h, raw, renderToString, SafeHtml } from "../src/html.ts";

describe("escape", () => {
  test("escapes the five HTML-significant characters", () => {
    expect(escape("<")).toBe("&lt;");
    expect(escape(">")).toBe("&gt;");
    expect(escape("&")).toBe("&amp;");
    expect(escape('"')).toBe("&quot;");
    expect(escape("'")).toBe("&#39;");
  });

  test("escapes a script-injection payload", () => {
    expect(escape("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("null/undefined become empty string; numbers stringify", () => {
    expect(escape(null)).toBe("");
    expect(escape(undefined)).toBe("");
    expect(escape(123)).toBe("123");
  });
});

describe("h tagged template", () => {
  test("escapes interpolated user values", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const out = h`<p>${evil}</p>`.toString();
    expect(out).toBe('<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
    expect(out).not.toContain("<img");
  });

  test("does NOT re-escape nested SafeHtml", () => {
    const inner = h`<strong>${"<b>"}</strong>`;
    const out = h`<div>${inner}</div>`.toString();
    expect(out).toBe("<div><strong>&lt;b&gt;</strong></div>");
  });

  test("joins arrays of fragments without separators", () => {
    const items = ["a", "<b>", "c"];
    const out = h`<ul>${items.map((i) => h`<li>${i}</li>`)}</ul>`.toString();
    expect(out).toBe("<ul><li>a</li><li>&lt;b&gt;</li><li>c</li></ul>");
  });

  test("false/null/undefined interpolations render as empty", () => {
    expect(h`${false}${null}${undefined}x`.toString()).toBe("x");
  });

  test("returns a SafeHtml instance", () => {
    expect(h`x`).toBeInstanceOf(SafeHtml);
  });
});

describe("raw", () => {
  test("passes through unescaped (trusted) and is not re-escaped by h", () => {
    const out = h`<div>${raw("<hr>")}</div>`.toString();
    expect(out).toBe("<div><hr></div>");
  });
});

describe("renderToString", () => {
  test("returns the underlying value for SafeHtml", () => {
    expect(renderToString(h`<p>ok</p>`)).toBe("<p>ok</p>");
  });

  test("defensively escapes a plain (untrusted) string", () => {
    expect(renderToString("<x>")).toBe("&lt;x&gt;");
  });
});
