import { describe, test, expect } from "bun:test";
import { tierLabel, statusLabel } from "../src/routes/my-shared.ts";

describe("tierLabel", () => {
  test("reviewed + reproduced is the active canonical top tier", () => {
    expect(tierLabel("reviewed", "reproduced")).toBe("active");
  });

  test("reviewed + failed reads as rejected", () => {
    expect(tierLabel("reviewed", "failed")).toBe("rejected");
  });

  test("reviewed + pending is pending acceptance", () => {
    expect(tierLabel("reviewed", "pending")).toBe("pending acceptance");
  });

  test("below review reads as pending review; draft stays draft", () => {
    expect(tierLabel("unreviewed", "pending")).toBe("pending review");
    expect(tierLabel("draft", "reproduced")).toBe("draft");
  });

  test("statusLabel covers the tiered moderation values", () => {
    expect(statusLabel("unreviewed")).toBe("pending review");
    expect(statusLabel("reviewed")).toBe("reviewed");
    expect(statusLabel("draft")).toBe("draft");
  });
});
