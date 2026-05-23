/**
 * Tests for src/layout.ts — the shared page chrome.
 *
 * layout() is pure (no DB): it only reads config + the inlined logo at import.
 * Several of these tests assert behavior REQUIRED BY THE OVERHAUL SPEC that the
 * current implementation does not yet satisfy; those are expected to FAIL and
 * are flagged in TESTING_HANDOFF.md. They are written as the spec intends so
 * that, once fixed, they turn green.
 */
import { test, expect, describe } from "bun:test";
import { layout } from "../src/layout.ts";
import { h } from "../src/html.ts";
import type { UserSession } from "../src/auth.ts";

const adminUser: UserSession = {
  userId: 1,
  username: "rudra",
  email: "r@example.com",
  isAdmin: true,
  emailVerified: true,
  token: "t",
};

const plainUser: UserSession = {
  ...adminUser,
  userId: 2,
  username: "warren",
  isAdmin: false,
};

function render(opts: Parameters<typeof layout>[0]): string {
  // layout() is currently synchronous and returns a string; await is harmless
  // and keeps the test robust if it later becomes async (per the spec).
  return layout(opts) as unknown as string;
}

describe("layout basics", () => {
  test("renders the title and body", () => {
    const html = render({ title: "My Title", body: h`<p>hello body</p>` });
    expect(html).toContain("<title>My Title</title>");
    expect(html).toContain("<p>hello body</p>");
  });

  test("escapes the page title", () => {
    const html = render({ title: "<script>x</script>", body: h`` });
    expect(html).not.toContain("<title><script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("logged-out nav shows log in / sign up", () => {
    const html = render({ title: "t", body: h``, user: null });
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/signup"');
  });

  test("logged-in nav shows the username and a CSRF-protected logout form", () => {
    const html = render({ title: "t", body: h``, user: plainUser, csrfToken: "CSRF123" });
    expect(html).toContain("warren");
    expect(html).toContain('action="/logout"');
    expect(html).toContain('value="CSRF123"');
  });

  test("admin nav exposes queue + all links", () => {
    const html = render({ title: "t", body: h``, user: adminUser });
    expect(html).toContain('href="/admin/queue"');
    expect(html).toContain('href="/admin/all"');
  });
});

describe("nav no longer links to removed routes (SPEC: /track and /lookup deleted)", () => {
  // /track and /lookup were deleted from the router in the overhaul. Any nav
  // link to them is now a dead 404 link. EXPECTED TO FAIL until layout.ts is
  // updated — see TESTING_HANDOFF.md (Bug A).
  test("does not link to /track", () => {
    const html = render({ title: "t", body: h``, user: null });
    expect(html).not.toContain('href="/track"');
  });

  test("does not link to /lookup", () => {
    const html = render({ title: "t", body: h``, user: null });
    expect(html).not.toContain('href="/lookup"');
  });
});

describe("nav additions required by the spec", () => {
  // SPEC §4c/§7: logged-in users get a "my drafts" link to /my/submissions.
  // EXPECTED TO FAIL — not implemented (Bug B).
  test("logged-in nav links to /my/submissions (my drafts)", () => {
    const html = render({ title: "t", body: h``, user: plainUser });
    expect(html).toContain('href="/my/submissions"');
  });

  // SPEC §4d: RSS auto-discovery <link> in <head>.
  // EXPECTED TO FAIL — not implemented (Bug C).
  test("head advertises the RSS feed", () => {
    const html = render({ title: "t", body: h`` });
    expect(html).toContain('type="application/rss+xml"');
    expect(html).toContain('href="/rss"');
  });
});
