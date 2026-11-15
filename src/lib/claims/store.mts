// Conditional MongoDB writes for installer claims, shared by the API (through
// src/lib/claims/service.ts) and the expiry worker (scripts/claim-expiry-worker.mts).
//
// Every state change is ONE single-document `update` command whose filter
// holds all preconditions, so check-and-change is atomic. Writes use
// MongoDB's clock ($$NOW) at write time, so the stored claimExpiresAt is the
// only source of truth for expiry. Tests may pass a fixed `now` instead.
//
// Plain .mts with no app imports so Node can load it without a bundler.
import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { CLAIM_TTL_MS, CLAIMABLE_STATUS } from "./constants.mts";

export type CommandRunner = Pick<PrismaClient, "$runCommandRaw">;
export type VerificationOutcome = "PASSED" | "FAILED";
type Command = Parameters<CommandRunner["$runCommandRaw"]>[0];

// MongoDB collection backing the Order model (@@map in prisma/schema.prisma).
const ORDERS_COLLECTION = "orders";

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** MongoDB's current time at write time, or a fixed time for tests. */
function nowExpr(now?: Date) {
  return now ? { $date: now.toISOString() } : "$$NOW";
}

const VERSION_PLUS_ONE = { $add: [{ $ifNull: ["$version", 0] }, 1] };

/** Free to claim: no claim (field missing/null/NONE) or a pending claim that has expired. */
function claimIsAvailable(at: ReturnType<typeof nowExpr>) {
  return {
    $or: [
      { $eq: [{ $ifNull: ["$claimState", "NONE"] }, "NONE"] },
      {
        $and: [
          { $eq: ["$claimState", "PENDING_VERIFICATION"] },
          { $lte: ["$claimExpiresAt", at] },
        ],
      },
    ],
  };
}

function releasedClaimFields(at: ReturnType<typeof nowExpr>) {
  return {
    claimState: "NONE",
    claimInstallerId: null,
    claimTokenHash: null,
    claimExpiresAt: null,
    claimedAt: null,
    claimConfirmedAt: null,
    version: VERSION_PLUS_ONE,
    updatedAt: at,
  };
}

/** Runs one conditional single-document update; returns how many documents matched (0 or 1). */
async function conditionalUpdate(
  db: CommandRunner,
  filter: Record<string, unknown>,
  pipeline: Record<string, unknown>[],
): Promise<number> {
  const result = await db.$runCommandRaw({
    update: ORDERS_COLLECTION,
    updates: [{ q: filter, u: pipeline }],
  } as Command);
  if (result.ok !== 1 || result.writeErrors) {
    throw new Error(`Claim update failed: ${JSON.stringify(result)}`);
  }
  return Number(result.n);
}

/**
 * Claims an order for `installerId` if it is READY_FOR_INSTALL and no active
 * claim exists. Sets a new token hash, expiry (now + 180 s) and bumps version.
 */
export async function tryClaim(
  db: CommandRunner,
  input: { orderId: string; installerId: string; tokenHash: string; now?: Date },
): Promise<boolean> {
  const at = nowExpr(input.now);
  const matched = await conditionalUpdate(
    db,
    { _id: { $oid: input.orderId }, status: CLAIMABLE_STATUS, $expr: claimIsAvailable(at) },
    [
      {
        $set: {
          claimState: "PENDING_VERIFICATION",
          claimInstallerId: { $literal: input.installerId },
          claimTokenHash: { $literal: input.tokenHash },
          claimExpiresAt: { $dateAdd: { startDate: at, unit: "millisecond", amount: CLAIM_TTL_MS } },
          claimedAt: at,
          claimConfirmedAt: null,
          version: VERSION_PLUS_ONE,
          updatedAt: at,
        },
      },
    ],
  );
  return matched === 1;
}

/**
 * Applies a (simulated) verification result to the matching pending claim:
 * same installer, same token, not yet expired. PASSED also requires the order
 * to still be READY_FOR_INSTALL and confirms the claim (confirmed claims never
 * expire); FAILED releases exactly that claim.
 */
export async function tryResolveVerification(
  db: CommandRunner,
  input: {
    orderId: string;
    installerId: string;
    tokenHash: string;
    outcome: VerificationOutcome;
    now?: Date;
  },
): Promise<boolean> {
  const at = nowExpr(input.now);
  const filter: Record<string, unknown> = {
    _id: { $oid: input.orderId },
    claimState: "PENDING_VERIFICATION",
    claimInstallerId: input.installerId,
    claimTokenHash: input.tokenHash,
    $expr: { $gt: ["$claimExpiresAt", at] },
  };
  if (input.outcome === "PASSED") filter.status = CLAIMABLE_STATUS;

  const update =
    input.outcome === "PASSED"
      ? {
          claimState: "CONFIRMED",
          claimTokenHash: null,
          claimExpiresAt: null,
          claimConfirmedAt: at,
          version: VERSION_PLUS_ONE,
          updatedAt: at,
        }
      : releasedClaimFields(at);
  return (await conditionalUpdate(db, filter, [{ $set: update }])) === 1;
}

/** MongoDB server time, used as the shared clock for clients and scans. */
export async function getDatabaseTime(db: CommandRunner): Promise<Date> {
  const hello = await db.$runCommandRaw({ hello: 1 });
  const localTime = hello.localTime as { $date: string | { $numberLong: string } } | undefined;
  const raw = localTime?.$date;
  if (raw === undefined) throw new Error("hello did not return localTime");
  return new Date(typeof raw === "string" ? raw : Number(raw.$numberLong));
}

/**
 * Releases pending claims whose expiry has passed. Safe to run concurrently
 * from several processes: each release is a conditional update that only
 * matches if the claim is still the same pending claim (same token hash) and
 * is expired at write time, so it never touches a confirmed claim or a newer
 * claim made in the meantime.
 */
export async function releaseExpiredClaims(
  db: CommandRunner,
  options: { now?: Date; limit?: number } = {},
): Promise<{ candidates: number; released: string[] }> {
  const limit = options.limit ?? 100;
  // Concrete cut-off so the scan can use the (claimState, claimExpiresAt) index.
  const cutoff = options.now ?? (await getDatabaseTime(db));
  const found = await db.$runCommandRaw({
    find: ORDERS_COLLECTION,
    filter: { claimState: "PENDING_VERIFICATION", claimExpiresAt: { $lte: { $date: cutoff.toISOString() } } },
    projection: { _id: 1, claimTokenHash: 1 },
    limit,
    singleBatch: true,
  } as Command);
  const candidates = ((found.cursor as { firstBatch?: unknown[] } | undefined)?.firstBatch ?? []) as {
    _id: { $oid: string };
    claimTokenHash?: string | null;
  }[];

  const at = nowExpr(options.now);
  const released: string[] = [];
  for (const candidate of candidates) {
    const matched = await conditionalUpdate(
      db,
      {
        _id: { $oid: candidate._id.$oid },
        claimState: "PENDING_VERIFICATION",
        claimTokenHash: candidate.claimTokenHash ?? null,
        $expr: { $lte: ["$claimExpiresAt", at] },
      },
      [{ $set: releasedClaimFields(at) }],
    );
    if (matched === 1) released.push(candidate._id.$oid);
  }
  return { candidates: candidates.length, released };
}

/**
 * Sweeps for expired claims every `intervalMs` until `signal` is aborted.
 * Resolves after the current sweep finishes, so a stop never interrupts a write.
 */
export async function runClaimExpiryWorker(options: {
  db: CommandRunner;
  intervalMs: number;
  signal: AbortSignal;
  limit?: number;
  log?: (message: string) => void;
}): Promise<void> {
  const { db, intervalMs, signal, limit = 100, log = console.log } = options;
  while (!signal.aborted) {
    let drained = true;
    try {
      const { released } = await releaseExpiredClaims(db, { limit });
      if (released.length > 0) {
        log(`released ${released.length} expired claim(s): ${released.join(", ")}`);
      }
      drained = released.length < limit;
    } catch (error) {
      log(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (drained) await sleep(intervalMs, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
