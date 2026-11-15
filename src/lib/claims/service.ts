import "server-only";

import { randomBytes } from "node:crypto";

import type { $Enums } from "@prisma/client";

import { toOrderDtoWithUploads } from "@/lib/orders/service";
import type { OrderDto } from "@/lib/orders/types";
import { prisma } from "@/lib/prisma";

import type { ClaimState } from "./claims";
import { CLAIMABLE_STATUS } from "./constants.mts";
import {
  hashClaimToken,
  tryClaim,
  tryResolveVerification,
  type VerificationOutcome,
} from "./store.mts";

// Fails to compile if the shared claim states and the Prisma enum drift apart.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const claimStatesMatchPrismaEnum: Equals<ClaimState, $Enums.ClaimState> = true;
void claimStatesMatchPrismaEnum;

// `now` lets tests use a fixed clock; production uses MongoDB's clock.
type ClockOptions = { now?: Date };

export type ClaimResult =
  | { ok: true; order: OrderDto; claimToken: string }
  | { ok: false; reason: "NOT_FOUND" | "NOT_CLAIMABLE" | "ALREADY_CLAIMED" };

export async function claimOrder(
  orderId: string,
  installerId: string,
  { now }: ClockOptions = {},
): Promise<ClaimResult> {
  const claimToken = randomBytes(32).toString("base64url");
  const tokenHash = hashClaimToken(claimToken);
  const claimed = await tryClaim(prisma, { orderId, installerId, tokenHash, now });

  // The write above decided the outcome; this read only builds the response
  // (or explains a refusal).
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (claimed && order?.claimTokenHash === tokenHash) {
    return { ok: true, order: await toOrderDtoWithUploads(order), claimToken };
  }
  if (!order) return { ok: false, reason: "NOT_FOUND" };
  if (order.status !== CLAIMABLE_STATUS) return { ok: false, reason: "NOT_CLAIMABLE" };
  return { ok: false, reason: "ALREADY_CLAIMED" };
}

export type VerificationResult =
  | { ok: true; order: OrderDto }
  | { ok: false; reason: "NOT_FOUND" | "CLAIM_EXPIRED" | "CLAIM_NOT_ACTIVE" };

export async function submitVerification(
  orderId: string,
  input: { installerId: string; claimToken: string; outcome: VerificationOutcome },
  { now }: ClockOptions = {},
): Promise<VerificationResult> {
  const tokenHash = hashClaimToken(input.claimToken);
  const applied = await tryResolveVerification(prisma, {
    orderId,
    installerId: input.installerId,
    tokenHash,
    outcome: input.outcome,
    now,
  });

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (applied && order) return { ok: true, order: await toOrderDtoWithUploads(order) };
  if (!order) return { ok: false, reason: "NOT_FOUND" };

  // Explain the refusal. If this is still the caller's pending claim on a
  // READY_FOR_INSTALL order, the only failed precondition was the expiry.
  const stillTheCallersClaim =
    order.claimState === "PENDING_VERIFICATION" &&
    order.claimInstallerId === input.installerId &&
    order.claimTokenHash === tokenHash &&
    (input.outcome === "FAILED" || order.status === CLAIMABLE_STATUS);
  return { ok: false, reason: stillTheCallersClaim ? "CLAIM_EXPIRED" : "CLAIM_NOT_ACTIVE" };
}
