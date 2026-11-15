import { describe, expect, it } from "vitest";

import { formatCountdown, getClaimRemainingMs, getEffectiveClaimState, NO_CLAIM, type ClaimDto } from "./claims";

const expiresAt = "2026-01-01T00:03:00.000Z";
const pending: ClaimDto = {
  state: "PENDING_VERIFICATION",
  installerId: "installer-alex",
  expiresAt,
  claimedAt: "2026-01-01T00:00:00.000Z",
  confirmedAt: null,
};
const expiry = Date.parse(expiresAt);

describe("getEffectiveClaimState", () => {
  it("maps NONE and CONFIRMED directly", () => {
    expect(getEffectiveClaimState(NO_CLAIM, expiry)).toBe("AVAILABLE");
    expect(getEffectiveClaimState({ ...pending, state: "CONFIRMED", expiresAt: null }, expiry + 1e9)).toBe("CONFIRMED");
  });

  it("shows a pending claim as expired from its expiry instant, before any cleanup", () => {
    expect(getEffectiveClaimState(pending, expiry - 1)).toBe("PENDING");
    expect(getEffectiveClaimState(pending, expiry)).toBe("EXPIRED");
    expect(getEffectiveClaimState(pending, expiry + 60_000)).toBe("EXPIRED");
  });
});

describe("countdown helpers", () => {
  it("computes the remaining time against the (server) clock", () => {
    expect(getClaimRemainingMs(pending, expiry - 61_500)).toBe(61_500);
    expect(getClaimRemainingMs(pending, expiry + 5)).toBe(0);
    expect(getClaimRemainingMs(NO_CLAIM, 0)).toBe(0);
  });

  it("formats as m:ss and rounds partial seconds up", () => {
    expect(formatCountdown(180_000)).toBe("3:00");
    expect(formatCountdown(61_500)).toBe("1:02");
    expect(formatCountdown(999)).toBe("0:01");
    expect(formatCountdown(0)).toBe("0:00");
  });
});
