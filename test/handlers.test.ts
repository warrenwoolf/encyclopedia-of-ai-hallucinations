/**
 * Route-handler tests for the read-mostly handlers that emit JSON / XML / a
 * redirect, exercised against a MOCKED src/db.ts so no MariaDB is required.
 *
 * One shared db mock (a SQL dispatcher) is installed for the whole file to
 * avoid cross-file mock leakage; per-test behavior is controlled via the
 * mutable `db` object and reset in beforeEach.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import type { RouteContext } from "../src/routes/types.ts";

const handlerDescribe = process.env.EAH_TEST_DB === "1" ? describe.skip : describe;

// ── mutable db behavior, closed over by the mock factory ──────────────────────
const db = {
  queryOne: async (_sql: string, _params?: unknown[]): Promise<any> => undefined,
  query: async (_sql: string, _params?: unknown[]): Promise<any[]> => [],
  execute: async (_sql: string, _params?: unknown[]) => ({ affectedRows: 0, insertId: 0 }),
  transaction: async (fn: any) =>
    fn({
      query: async () => [],
      queryOne: async () => undefined,
      execute: async () => ({ affectedRows: 0, insertId: 0 }),
    }),
};

// Handler references populated in beforeAll, after the mock is installed.
let usernameCheck: any;
let rss: any;
let sitemap: any;
let entry: any;
let postReview: any;
let postReviewMessage: any;

// Saved real module — captured under a separate import key so Bun does not
// live-update it when the mocked `../src/db.ts` binding changes.
let _savedRealDb: any;
const realDbUrl = new URL("../src/db.ts?real=1", import.meta.url).href;

// Install the db mock and import handlers inside beforeAll rather than at
// module-load time. This is critical: all test files are evaluated (static
// imports resolved) before any beforeAll runs. By deferring mock.module to
// beforeAll, db.test.ts's static `import from "../../src/db.ts"` sees the
// REAL module when the file is first evaluated, not the mock. Without this,
// mock.module at module level would contaminate the integration tests.
//
// We also save the real module BEFORE calling mock.module so that afterAll
// can reliably restore it via mock.module again (restoring live bindings for
// all modules that imported src/db.ts, including the integration harness).
beforeAll(async () => {
  // Save the real implementation before installing the mock.
  _savedRealDb = await import(realDbUrl);

  // When running the full test suite with a real integration DB (EAH_TEST_DB=1)
  // we must NOT install the db mock here. Installing a mock at runtime can
  // race with other test files and contaminate the integration harness. In
  // that mode we simply import the handlers normally so they use the real
  // `src/db.ts` implementation created by the preload.
  if (process.env.EAH_TEST_DB === "1") {
    usernameCheck = (await import("../src/routes/api.ts")).usernameCheck;
    rss = (await import("../src/routes/rss.ts")).rss;
    sitemap = (await import("../src/routes/sitemap.ts")).sitemap;
    entry = (await import("../src/routes/entry.ts")).entry;
    ({ postReview, postReviewMessage } = await import("../src/routes/admin/review.ts"));
    return;
  }

  mock.module("../src/db.ts", () => ({
    pool: { getConnection: async () => ({}), end: async () => {} },
    query: (sql: string, params?: unknown[]) => db.query(sql, params),
    queryOne: (sql: string, params?: unknown[]) => db.queryOne(sql, params),
    execute: (sql: string, params?: unknown[]) => db.execute(sql, params),
    transaction: (fn: any) => db.transaction(fn),
  }));

  // Import handlers AFTER the mock is registered so they pick up the mock.
  usernameCheck = (await import("../src/routes/api.ts")).usernameCheck;
  rss = (await import("../src/routes/rss.ts")).rss;
  sitemap = (await import("../src/routes/sitemap.ts")).sitemap;
  entry = (await import("../src/routes/entry.ts")).entry;
  ({ postReview, postReviewMessage } = await import("../src/routes/admin/review.ts"));
});

// Restore the real src/db.ts after all handler tests complete so the
// integration suite (which runs in the same Bun process) sees the real pool.
// Without this restore, mock.module's live-binding replacement would cause
// the integration test's already-resolved static imports to point at the mock.
afterAll(() => {
  if (_savedRealDb) {
    mock.module("../src/db.ts", () => ({ ..._savedRealDb }));
  }
});

function ctx(opts: Partial<RouteContext> & { path?: string; ip?: string } = {}): RouteContext {
  const url = new URL(opts.path ?? "http://localhost:8090/");
  return {
    params: opts.params ?? {},
    url,
    ip: opts.ip ?? "test-ip",
    user: opts.user ?? null,
    admin: opts.admin ?? null,
  };
}

beforeEach(() => {
  db.queryOne = async () => undefined;
  db.query = async () => [];
  db.execute = async () => ({ affectedRows: 0, insertId: 0 });
});

// ── /api/username-check ───────────────────────────────────────────────────────

handlerDescribe("GET /api/username-check", () => {
  test("returns JSON content type", async () => {
    const res = await usernameCheck(
      new Request("http://x/api/username-check?u=newname"),
      ctx({ path: "http://x/api/username-check?u=newname", ip: "api-ok" }),
    );
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  test("available:true when no matching user exists", async () => {
    db.queryOne = async () => undefined;
    const res = await usernameCheck(
      new Request("http://x"),
      ctx({ path: "http://x/api/username-check?u=freshuser", ip: "api-ok" }),
    );
    expect(await res.json()).toEqual({ available: true });
  });

  test("available:false when the username is taken", async () => {
    db.queryOne = async () => ({ id: 5 });
    const res = await usernameCheck(
      new Request("http://x"),
      ctx({ path: "http://x/api/username-check?u=takenuser", ip: "api-ok" }),
    );
    expect(await res.json()).toEqual({ available: false });
  });

  test("available:false (without a DB hit) for an invalid username format", async () => {
    let hit = false;
    db.queryOne = async () => {
      hit = true;
      return undefined;
    };
    const res = await usernameCheck(
      new Request("http://x"),
      ctx({ path: "http://x/api/username-check?u=ab", ip: "api-ok" }), // too short
    );
    expect(await res.json()).toEqual({ available: false });
    expect(hit).toBe(false); // never queried for an invalid name
  });

  test("returns 429 once the api rate-limit bucket (20) is exhausted", async () => {
    const ip = "api-429-exhaust";
    let last: Response | null = null;
    for (let i = 0; i < 25; i++) {
      last = await usernameCheck(
        new Request("http://x"),
        ctx({ path: "http://x/api/username-check?u=somename", ip }),
      );
    }
    expect(last!.status).toBe(429);
  });
});

// ── /rss ──────────────────────────────────────────────────────────────────────

handlerDescribe("GET /rss", () => {
  test("sets the RSS content type and is well-formed at the top level", async () => {
    db.query = async () => [];
    const res = await rss(new Request("http://x/rss"), ctx());
    expect(res.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<rss");
    expect(xml).toContain("<channel>");
  });

  test("renders an item per published row and XML-escapes the title", async () => {
    db.query = async () => [
      {
        eah_number: 1,
        public_id: "pid1",
        title: "test1 & <x>",
        summary: "summary1",
        prompt: "prompt1",
        ai_model: "model1",
        submitted_at: new Date("2026-05-21T00:00:00Z"),
        reviewed_at: new Date("2026-05-22T00:00:00Z"),
      },
    ];
    const xml = await (await rss(new Request("http://x/rss"), ctx())).text();
    expect(xml).toContain("<item>");
    expect(xml).toContain("A000001");
    // the & and < in the title must be XML-escaped
    expect(xml).toContain("test1 &amp; &lt;x&gt;");
    expect(xml).not.toContain("<x>");
    // guid/link use the canonical A-number entry URL
    expect(xml).toContain("/e/A000001");
    // description prefers the summary
    expect(xml).toContain("<description>summary1</description>");
  });

  test("falls back to a prompt excerpt when there is no summary", async () => {
    db.query = async () => [
      {
        eah_number: 2,
        public_id: "pid2",
        title: "test2",
        summary: null,
        prompt: "promptexcerpt2",
        ai_model: "model2",
        submitted_at: new Date("2026-01-01T00:00:00Z"),
        reviewed_at: null,
      },
    ];
    const xml = await (await rss(new Request("http://x/rss"), ctx())).text();
    expect(xml).toContain("promptexcerpt2");
  });
});

// ── /sitemap.xml ────────────────────────────────────────────────────────────

handlerDescribe("GET /sitemap.xml", () => {
  test("returns XML with the static pages and published entry URLs", async () => {
    db.query = async () => [
      { eah_number: 1, lastmod: new Date("2026-05-21T00:00:00Z") },
      { eah_number: 2, lastmod: "2026-05-22" },
    ];
    const res = await sitemap(new Request("http://x/sitemap.xml"), ctx());
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    const xml = await res.text();
    expect(xml).toContain("<urlset");
    expect(xml).toContain("http://localhost:8090/browse");
    expect(xml).toContain("http://localhost:8090/e/A000001");
    expect(xml).toContain("<lastmod>2026-05-21</lastmod>");
  });
});

// ── /e/:public_id ─────────────────────────────────────────────────────────────

handlerDescribe("GET /e/:public_id", () => {
  test("404 for a malformed id (no DB hit)", async () => {
    let hit = false;
    db.queryOne = async () => {
      hit = true;
      return undefined;
    };
    const res = await entry(new Request("http://x/e/!!!"), ctx({ params: { public_id: "!!!" } }));
    expect(res.status).toBe(404);
    expect(hit).toBe(false);
  });

  test("301-redirects a legacy public_id to the canonical A-number URL", async () => {
    // parseEahId("legacyslug0") === null → public_id branch.
    db.queryOne = async (sql: string) => {
      if (/WHERE public_id/i.test(sql)) {
        return { id: 9, public_id: "legacyslug0", eah_number: 7, status: "reviewed", repro_status: "reproduced" };
      }
      return undefined;
    };
    const res = await entry(
      new Request("http://x/e/legacyslug0"),
      ctx({ params: { public_id: "legacyslug0" } }),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/e/A000007");
  });

  test("404 when the row exists but is a private draft", async () => {
    db.queryOne = async (sql: string) => {
      if (/WHERE eah_number/i.test(sql)) {
        return { id: 3, public_id: "p", eah_number: 3, status: "draft", repro_status: "pending" };
      }
      return undefined;
    };
    const res = await entry(
      new Request("http://x/e/A000003"),
      ctx({ params: { public_id: "A000003" } }),
    );
    expect(res.status).toBe(404);
  });
});

// ── admin auth gate (no DB hit on the unauthenticated path) ───────────────────

handlerDescribe("admin actions redirect unauthenticated requests to a REAL login route", () => {
  // BUG D (see TESTING_HANDOFF.md): postReview / postReviewMessage
  // redirect to "/admin/login", which is NOT a registered route (the login page
  // is "/login"). So an unauthenticated admin POST lands on a 404. The
  // equivalent /my/* handlers correctly use "/login".
  //
  // These assertions encode the CORRECT target ("/login") and are EXPECTED TO
  // FAIL until the redirect is fixed.
  const post = (path: string) =>
    new Request(`http://x${path}`, { method: "POST" });

  test("postReview → /login when not an admin", async () => {
    const res = await postReview(post("/admin/queue/1"), ctx({ params: { id: "1" } }));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login");
  });

  test("postReviewMessage → /login when not an admin", async () => {
    const res = await postReviewMessage(post("/admin/queue/1/message"), ctx({ params: { id: "1" } }));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login");
  });
});
