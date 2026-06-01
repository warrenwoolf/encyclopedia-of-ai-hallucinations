import { describe, test, expect } from "bun:test";
import { tierLabel, statusLabel } from "../src/routes/my-shared.ts";

describe("tierLabel", () => {
  test("reviewed + reproduced is the canonical top tier", () => {
    expect(tierLabel("reviewed", "reproduced")).toBe("reproduced");
  });

  test("reviewed + failed reads as failed to reproduce", () => {
    expect(tierLabel("reviewed", "failed")).toBe("failed to reproduce");
  });

  test("reviewed + pending is just reviewed", () => {
    expect(tierLabel("reviewed", "pending")).toBe("reviewed");
  });

  test("below review, repro_status is irrelevant", () => {
    expect(tierLabel("unreviewed", "pending")).toBe("unreviewed");
    expect(tierLabel("draft", "reproduced")).toBe("draft");
  });

  test("statusLabel covers the tiered moderation values", () => {
    expect(statusLabel("unreviewed")).toBe("unreviewed");
    expect(statusLabel("reviewed")).toBe("reviewed");
    expect(statusLabel("draft")).toBe("draft");
  });
});
