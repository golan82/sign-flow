import { describe, expect, it } from "vitest";

import type { OrderDto } from "@/lib/orders/types";

import { NO_CLAIM, type ClaimDto } from "./claims";
import { findEndedHeldClaims, type HeldClaim } from "./held-claims";

const t0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

const jordanHeld: HeldClaim = {
  orderId: "order-1",
  installerId: "installer-jordan",
  token: "token",
  claimedAt: iso(0),
};
const jordanClaim: ClaimDto = {
  state: "PENDING_VERIFICATION",
  installerId: "installer-jordan",
  claimedAt: iso(0),
  expiresAt: iso(180_000),
  confirmedAt: null,
};

function order(claim: ClaimDto, status: OrderDto["status"] = "READY_FOR_INSTALL"): OrderDto {
  return {
    id: "order-1",
    title: "Lobby sign",
    description: null,
    status,
    version: 5,
    createdAt: iso(-60_000),
    updatedAt: iso(0),
    claim,
    vendorId: "vendor-metro",
    uploads: [],
  };
}

describe("findEndedHeldClaims", () => {
  it("keeps a held claim while it is pending", () => {
    expect(findEndedHeldClaims([order(jordanClaim)], [jordanHeld], t0 + 179_999)).toEqual([]);
  });

  it("reports expiry seen by this tab before the worker releases the claim", () => {
    expect(findEndedHeldClaims([order(jordanClaim)], [jordanHeld], t0 + 180_000)).toEqual([
      { orderId: "order-1", title: "Lobby sign", expired: true },
    ]);
  });

  // Regression: the worker can release the claim before this tab's clock
  // passes its expiry, so the tab only ever sees the released order.
  it("reports expiry when the tab only sees the release or another installer's claim", () => {
    const sam: ClaimDto = { ...jordanClaim, installerId: "installer-sam", claimedAt: iso(200_000), expiresAt: iso(380_000) };
    const samConfirmed: ClaimDto = { ...sam, state: "CONFIRMED", expiresAt: null, confirmedAt: iso(210_000) };
    for (const claim of [NO_CLAIM, sam, samConfirmed]) {
      expect(findEndedHeldClaims([order(claim)], [jordanHeld], t0 + 1_000)).toEqual([
        { orderId: "order-1", title: "Lobby sign", expired: true },
      ]);
    }
  });

  it("drops the token without an expiry notice when the order left ready-for-install", () => {
    expect(findEndedHeldClaims([order(NO_CLAIM, "COMPLETED")], [jordanHeld], t0 + 1_000)).toEqual([
      { orderId: "order-1", title: "Lobby sign", expired: false },
    ]);
  });

  it("does not call this tab's own confirmed claim expired", () => {
    const confirmed: ClaimDto = { ...jordanClaim, state: "CONFIRMED", expiresAt: null, confirmedAt: iso(10_000) };
    expect(findEndedHeldClaims([order(confirmed)], [jordanHeld], t0 + 20_000)).toEqual([
      { orderId: "order-1", title: "Lobby sign", expired: false },
    ]);
  });

  // Regression: the live update releasing the claim after a FAILED verification
  // arrived before the HTTP response and was reported as an expiry.
  it("never calls a claim with a verification in flight expired", () => {
    const verifying = { ...jordanHeld, verifying: true };
    const confirmed: ClaimDto = { ...jordanClaim, state: "CONFIRMED", expiresAt: null, confirmedAt: iso(10_000) };
    expect(findEndedHeldClaims([order(NO_CLAIM)], [verifying], t0 + 10_000)).toEqual([
      { orderId: "order-1", title: "Lobby sign", expired: false },
    ]);
    expect(findEndedHeldClaims([order(confirmed)], [verifying], t0 + 10_000)).toEqual([
      { orderId: "order-1", title: "Lobby sign", expired: false },
    ]);
    // Clock past expiry while the response is pending: the response decides.
    expect(findEndedHeldClaims([order(jordanClaim)], [verifying], t0 + 180_000)).toEqual([]);
  });

  it("Sam's tab: claim, fail, claim again, pass, complete — no expiry reported", () => {
    const sam1: HeldClaim = { orderId: "order-1", installerId: "installer-sam", token: "t1", claimedAt: iso(200_000) };
    const sam2: HeldClaim = { ...sam1, token: "t2", claimedAt: iso(220_000) };
    const pending = (held: HeldClaim): ClaimDto => ({
      state: "PENDING_VERIFICATION",
      installerId: held.installerId,
      claimedAt: held.claimedAt,
      expiresAt: new Date(Date.parse(held.claimedAt) + 180_000).toISOString(),
      confirmedAt: null,
    });
    const confirmed: ClaimDto = { ...pending(sam2), state: "CONFIRMED", expiresAt: null, confirmedAt: iso(230_000) };
    const steps: [OrderDto, HeldClaim[], number][] = [
      [order(pending(sam1)), [sam1], t0 + 205_000],
      [order(NO_CLAIM), [{ ...sam1, verifying: true }], t0 + 210_000], // FAILED, live update first
      [order(pending(sam2)), [sam2], t0 + 225_000],
      [order(confirmed), [{ ...sam2, verifying: true }], t0 + 230_000], // PASSED, live update first
      [order(confirmed, "COMPLETED"), [sam2], t0 + 240_000], // token not yet dropped
    ];
    for (const [current, held, now] of steps) {
      expect(findEndedHeldClaims([current], held, now).filter((ended) => ended.expired)).toEqual([]);
    }
  });

  it("waits while the order is not in the list", () => {
    expect(findEndedHeldClaims([], [jordanHeld], t0 + 1e9)).toEqual([]);
  });
});
