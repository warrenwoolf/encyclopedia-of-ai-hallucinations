/**
 * Tests for src/email.ts. With RESEND_API_KEY unset (see test/setup.ts) every
 * send no-ops, so we can assert the "never throws" contract without hitting the
 * network, plus the quota-gate logic.
 */
import { test, expect, describe } from "bun:test";
import {
  sendDecision,
  sendReviewerMessage,
  sendVerificationCode,
  emailCapReached,
  emailsSentThisMonth,
} from "../src/email.ts";

describe("send* never throw (best-effort side channel)", () => {
  test("sendDecision (approved) resolves to undefined", async () => {
    await expect(
      sendDecision({
        to: "user@example.com",
        eahId: "A000001",
        publicId: "abc",
        modelLabel: "GPT-4o",
        decision: "approved",
        staffReviewMessage: null,
        rejectionReason: null,
      }),
    ).resolves.toBeUndefined();
  });

  test("sendDecision (rejected) resolves to undefined", async () => {
    await expect(
      sendDecision({
        to: "user@example.com",
        eahId: "",
        publicId: "abc",
        modelLabel: "GPT-4o",
        decision: "rejected",
        staffReviewMessage: "see notes",
        rejectionReason: "duplicate",
      }),
    ).resolves.toBeUndefined();
  });

  test("sendReviewerMessage resolves to undefined", async () => {
    await expect(
      sendReviewerMessage({
        to: "user@example.com",
        eahId: "A000001",
        modelLabel: "Claude",
        reviewerName: "rudra",
        bodyPreview: "looks good",
      }),
    ).resolves.toBeUndefined();
  });

  test("sendVerificationCode resolves to undefined", async () => {
    await expect(
      sendVerificationCode({ to: "user@example.com", code: "123456", username: "warren" }),
    ).resolves.toBeUndefined();
  });
});

describe("quota gate", () => {
  test("emailsSentThisMonth is null before any Resend response is observed", () => {
    expect(emailsSentThisMonth()).toBeNull();
  });

  test("emailCapReached fails OPEN when usage is unknown", () => {
    // Unknown usage must never block sends.
    expect(emailCapReached()).toBe(false);
  });
});
