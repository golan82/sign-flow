import type { OrderDto } from "@/lib/orders/types";

import { getEffectiveClaimState } from "./claims";
import { CLAIMABLE_STATUS } from "./constants.mts";

/**
 * A claim token this browser tab received when it claimed an order. The claim
 * is identified by installer + claimedAt (fixed for the claim's lifetime);
 * its expiry is always read from the latest server data.
 */
export type HeldClaim = {
  orderId: string;
  installerId: string;
  token: string;
  claimedAt: string;
  /**
   * This tab sent a verification result and is waiting for the response. The
   * live update that releases (FAILED) or confirms (PASSED) the claim can
   * arrive before that response; it must not be read as an expiry.
   */
  verifying?: boolean;
};

/** A held token only counts while it belongs to the order's current pending claim. */
export function matchingHeldClaim(order: OrderDto, held: HeldClaim | undefined): HeldClaim | undefined {
  const { claim } = order;
  return held &&
    claim.state === "PENDING_VERIFICATION" &&
    claim.installerId === held.installerId &&
    claim.claimedAt === held.claimedAt
    ? held
    : undefined;
}

export type EndedHeldClaim = { orderId: string; title: string; expired: boolean };

/**
 * Held claims that are over, decided from the latest order data at `nowMs`, so
 * it does not matter whether this tab saw the claim expire or only the result:
 * its release by the expiry worker or another installer's claim.
 *
 * `expired` is true only when the claim ran out before verification: the
 * order is still ready for install and no verification from this tab is in
 * flight. A failed or passed verification (`verifying`), confirmation and a
 * status change such as completion are never reported as expiry. While a
 * verification is in flight, its response decides the outcome.
 */
export function findEndedHeldClaims(
  orders: OrderDto[],
  heldClaims: HeldClaim[],
  nowMs: number,
): EndedHeldClaim[] {
  const ended: EndedHeldClaim[] = [];
  for (const held of heldClaims) {
    // Not in the list (yet): keep the token until the data shows the order.
    const order = orders.find((candidate) => candidate.id === held.orderId);
    if (!order) continue;
    if (matchingHeldClaim(order, held)) {
      if (!held.verifying && getEffectiveClaimState(order.claim, nowMs) === "EXPIRED") {
        ended.push({ orderId: order.id, title: order.title, expired: true });
      }
      continue;
    }
    const confirmedForHolder =
      order.claim.state === "CONFIRMED" &&
      order.claim.installerId === held.installerId &&
      order.claim.claimedAt === held.claimedAt;
    ended.push({
      orderId: order.id,
      title: order.title,
      expired: !held.verifying && order.status === CLAIMABLE_STATUS && !confirmedForHolder,
    });
  }
  return ended;
}
