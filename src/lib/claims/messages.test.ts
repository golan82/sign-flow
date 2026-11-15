import { describe, expect, it } from "vitest";

import { getClaimViewKey, NO_CLAIM, type ClaimDto } from "./claims";
import { claimExpiredNotice } from "./messages";

// Regression: Jordan's claim expires, Sam claims and is verified. Jordan's tab
// kept showing "Claimed as Jordan Lee" and "The job is open to installers again".
const t0 = Date.parse("2026-01-01T00:00:00.000Z");
const jordanClaim: ClaimDto = {
  state: "PENDING_VERIFICATION",
  installerId: "installer-jordan",
  claimedAt: new Date(t0).toISOString(),
  expiresAt: new Date(t0 + 180_000).toISOString(),
  confirmedAt: null,
};
const samClaim: ClaimDto = {
  state: "PENDING_VERIFICATION",
  installerId: "installer-sam",
  claimedAt: new Date(t0 + 200_000).toISOString(),
  expiresAt: new Date(t0 + 380_000).toISOString(),
  confirmedAt: null,
};
const samConfirmed: ClaimDto = { ...samClaim, state: "CONFIRMED", expiresAt: null, confirmedAt: new Date(t0 + 210_000).toISOString() };

describe("getClaimViewKey (keeps local claim messages in step with the order)", () => {
  const jordanMessageKey = getClaimViewKey(jordanClaim, t0);

  it("stays the same while the countdown runs", () => {
    expect(getClaimViewKey(jordanClaim, t0 + 179_999)).toBe(jordanMessageKey);
  });

  it("changes when the claim expires, even before the worker releases it", () => {
    expect(getClaimViewKey(jordanClaim, t0 + 180_000)).not.toBe(jordanMessageKey);
  });

  it("changes on release, on another installer's claim and on its confirmation", () => {
    const later = [
      getClaimViewKey(NO_CLAIM, t0 + 190_000),
      getClaimViewKey(samClaim, t0 + 200_000),
      getClaimViewKey(samConfirmed, t0 + 210_000),
    ];
    expect(later).not.toContain(jordanMessageKey);
    expect(new Set(later).size).toBe(3);
  });

  it("does not confuse two claims by the same installer", () => {
    const again = { ...jordanClaim, claimedAt: new Date(t0 + 300_000).toISOString(), expiresAt: new Date(t0 + 480_000).toISOString() };
    expect(getClaimViewKey(again, t0 + 300_000)).not.toBe(getClaimViewKey(jordanClaim, t0));
  });

  it("keeps a confirmation message current over time", () => {
    expect(getClaimViewKey(samConfirmed, t0 + 1e9)).toBe(getClaimViewKey(samConfirmed, t0 + 210_000));
  });
});

describe("claimExpiredNotice", () => {
  it("describes the past claim without claiming the job is available now", () => {
    const text = claimExpiredNotice("Shopfront install");
    expect(text).toBe("Your previous claim on “Shopfront install” expired before verification.");
    expect(text).not.toMatch(/open|available|again/i);
  });
});
