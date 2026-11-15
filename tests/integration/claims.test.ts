// Installer claims against the real MongoDB test database.
// Time-sensitive cases inject a fixed clock (`now`) into the service/store, or
// set a dedicated expiry on a test record; nothing waits three minutes and the
// production TTL is unchanged.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it, vi } from "vitest";

import { POST as claimHandler } from "@/app/api/orders/[id]/claim/route";
import { POST as verificationHandler } from "@/app/api/orders/[id]/claim/verification/route";
import { PATCH as statusHandler } from "@/app/api/orders/[id]/status/route";
import { GET as listHandler } from "@/app/api/orders/route";
import { CLAIM_TTL_MS } from "@/lib/claims/constants.mts";
import { claimOrder, submitVerification } from "@/lib/claims/service";
import {
  hashClaimToken,
  releaseExpiredClaims,
  runClaimExpiryWorker,
  tryClaim,
  type CommandRunner,
} from "@/lib/claims/store.mts";
import type { OrderStatus } from "@/lib/orders/status";
import type { ApiErrorBody, OrderDto } from "@/lib/orders/types";
import { prisma } from "@/lib/prisma";

import {
  createTestOrder,
  deleteTrackedRecords,
  jsonRequest,
  readRecord,
  setStatusDirectly,
  testTitle,
  toJson,
  trackId,
  withTestRecords,
} from "./helpers";

vi.mock("next/server", () => ({ connection: async () => {} }));

const ALEX = "installer-alex";
const SAM = "installer-sam";
const JORDAN = "installer-jordan";
// Fixed clock for time-injected tests.
const T = new Date("2031-01-01T00:00:00.000Z");
const at = (ms: number) => new Date(T.getTime() + ms);

type ClaimBody = { order: OrderDto; claimToken: string } & ApiErrorBody;

async function claimViaApi(id: string, body: unknown) {
  return toJson<ClaimBody>(
    await claimHandler(jsonRequest(`http://localhost/api/orders/${id}/claim`, "POST", body), {
      params: Promise.resolve({ id }),
    }),
  );
}

async function verifyViaApi(id: string, body: unknown) {
  return toJson<{ order: OrderDto } & ApiErrorBody>(
    await verificationHandler(
      jsonRequest(`http://localhost/api/orders/${id}/claim/verification`, "POST", body),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function createReadyOrder(label: string): Promise<OrderDto> {
  const order = await createTestOrder(label);
  await setStatusDirectly(order.id, "READY_FOR_INSTALL");
  return order;
}

/** Test-only: move a tracked test claim's expiry into the past. */
async function expireClaimNow(id: string) {
  await prisma.order.update({ where: { id }, data: { claimExpiresAt: new Date(Date.now() - 1_000) } });
}

const randomToken = () => randomBytes(32).toString("base64url");
const missingId = () => randomBytes(12).toString("hex");

afterAll(async () => {
  await deleteTrackedRecords();
  await prisma.$disconnect();
});

describe("POST /api/orders/[id]/claim", () => {
  it("claims a READY_FOR_INSTALL order and returns the token only to the claimer", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("claim ok");
      const before = await readRecord(order.id);

      const response = await claimViaApi(order.id, { installerId: ALEX });

      expect(response.status).toBe(201);
      const { claimToken, order: claimed } = response.body;
      expect(claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(claimed.claim).toMatchObject({ state: "PENDING_VERIFICATION", installerId: ALEX });
      expect(claimed.version).toBe(before.version + 1);
      expect(Date.parse(claimed.claim.expiresAt!) - Date.parse(claimed.claim.claimedAt!)).toBe(CLAIM_TTL_MS);
      // Only the hash is stored; neither token nor hash is in the order DTO.
      const stored = await readRecord(order.id);
      expect(stored.claimTokenHash).toBe(hashClaimToken(claimToken));
      expect(JSON.stringify(claimed)).not.toContain(claimToken);
      expect(JSON.stringify(claimed)).not.toContain(stored.claimTokenHash!);

      const list = await toJson<{ orders: OrderDto[]; serverTime: string }>(await listHandler());
      const listed = JSON.stringify(list.body);
      expect(listed).not.toContain(claimToken);
      expect(listed).not.toContain(stored.claimTokenHash!);
      expect(Date.parse(list.body.serverTime)).not.toBeNaN();
    }));

  it.each<OrderStatus>(["DRAFT", "SUBMITTED", "VENDOR_ACCEPTED", "IN_PRODUCTION", "COMPLETED", "CANCELLED"])(
    "rejects claiming a %s order with 400 and leaves it unchanged",
    (status) =>
      withTestRecords(async () => {
        const order = await createTestOrder(`not claimable ${status}`);
        await setStatusDirectly(order.id, status);
        const before = await readRecord(order.id);

        const response = await claimViaApi(order.id, { installerId: ALEX });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("ORDER_NOT_CLAIMABLE");
        expect(await readRecord(order.id)).toEqual(before);
      }),
  );

  it.each([
    ["an unknown installer", { installerId: "installer-mallory" }],
    ["a missing installer", {}],
    ["an unexpected field", { installerId: ALEX, claimToken: "x" }],
  ])("rejects %s with 400", (_label, body) =>
    withTestRecords(async () => {
      const order = await createReadyOrder("claim validation");
      const before = await readRecord(order.id);
      const response = await claimViaApi(order.id, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(await readRecord(order.id)).toEqual(before);
    }),
  );

  it("returns 400 for a malformed id and 404 for a missing order", async () => {
    expect((await claimViaApi("nope", { installerId: ALEX })).status).toBe(400);
    const missing = await claimViaApi(missingId(), { installerId: ALEX });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("works on documents written before claim fields existed", () =>
    withTestRecords(async () => {
      const now = { $date: new Date().toISOString() };
      const inserted = await prisma.$runCommandRaw({
        insert: "orders",
        documents: [
          { title: testTitle("legacy"), status: "READY_FOR_INSTALL", version: 2, createdAt: now, updatedAt: now },
        ],
      });
      expect(inserted.n).toBe(1);
      const legacy = await prisma.order.findFirstOrThrow({ where: { title: testTitle("legacy") } });
      trackId(legacy.id);
      expect(legacy.claimState).toBeNull();

      const list = await toJson<{ orders: OrderDto[] }>(await listHandler());
      expect(list.body.orders.find((o) => o.id === legacy.id)?.claim.state).toBe("NONE");

      const response = await claimViaApi(legacy.id, { installerId: SAM });
      expect(response.status).toBe(201);
      expect(response.body.order).toMatchObject({ version: 3, claim: { state: "PENDING_VERIFICATION" } });
    }));
});

describe("claim concurrency", () => {
  it("lets exactly one of two simultaneous claims win; the other gets 409", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("claim pair");
      const before = await readRecord(order.id);

      const responses = await Promise.all([
        claimViaApi(order.id, { installerId: ALEX }),
        claimViaApi(order.id, { installerId: SAM }),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
      const winner = responses.find((r) => r.status === 201)!;
      const loser = responses.find((r) => r.status === 409)!;
      expect(loser.body.error.code).toBe("CLAIM_UNAVAILABLE");
      const stored = await readRecord(order.id);
      expect(stored.claimInstallerId).toBe(winner.body.order.claim.installerId);
      expect(stored.claimTokenHash).toBe(hashClaimToken(winner.body.claimToken));
      expect(stored.version).toBe(before.version + 1);
    }));

  it("lets exactly one of a burst of twelve claims win", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("claim burst");
      const before = await readRecord(order.id);
      const installers = [ALEX, SAM, JORDAN];

      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, i) => claimViaApi(order.id, { installerId: installers[i % 3] })),
      );

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(11);
      const winner = responses.find((r) => r.status === 201)!;
      const stored = await readRecord(order.id);
      expect(stored.claimTokenHash).toBe(hashClaimToken(winner.body.claimToken));
      expect(stored.version).toBe(before.version + 1);
    }));
});

describe("claim expiry", () => {
  it("an unexpired claim blocks other installers (and the same installer)", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("blocks");
      expect((await claimOrder(order.id, ALEX, { now: T })).ok).toBe(true);
      const before = await readRecord(order.id);

      for (const installer of [SAM, ALEX]) {
        const result = await claimOrder(order.id, installer, { now: at(CLAIM_TTL_MS - 1) });
        expect(result).toEqual({ ok: false, reason: "ALREADY_CLAIMED" });
      }
      expect(await readRecord(order.id)).toEqual(before);
    }));

  it("an expired claim can be claimed again before the cleanup runs", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("reclaim");
      const first = await claimOrder(order.id, ALEX, { now: T });
      expect(first.ok).toBe(true);
      expect((await readRecord(order.id)).claimState).toBe("PENDING_VERIFICATION"); // not cleaned

      const second = await claimOrder(order.id, SAM, { now: at(CLAIM_TTL_MS) });

      expect(second.ok).toBe(true);
      const stored = await readRecord(order.id);
      expect(stored).toMatchObject({ claimState: "PENDING_VERIFICATION", claimInstallerId: SAM });
      expect(stored.claimExpiresAt?.toISOString()).toBe(at(2 * CLAIM_TTL_MS).toISOString());
      expect(stored.claimTokenHash).toBe(hashClaimToken(second.ok ? second.claimToken : ""));
    }));

  it("confirms before expiry and refuses at or after the expiry instant", () =>
    withTestRecords(async () => {
      const late = await createReadyOrder("verify late");
      const lateClaim = await claimOrder(late.id, ALEX, { now: T });
      if (!lateClaim.ok) throw new Error("claim failed");
      const before = await readRecord(late.id);
      for (const [offset, outcome] of [
        [CLAIM_TTL_MS, "PASSED"],
        [CLAIM_TTL_MS + 20_000, "PASSED"],
        [CLAIM_TTL_MS, "FAILED"],
      ] as const) {
        const result = await submitVerification(
          late.id,
          { installerId: ALEX, claimToken: lateClaim.claimToken, outcome },
          { now: at(offset) },
        );
        expect(result, `${outcome} at +${offset}`).toEqual({ ok: false, reason: "CLAIM_EXPIRED" });
      }
      expect(await readRecord(late.id)).toEqual(before);

      const onTime = await createReadyOrder("verify on time");
      const onTimeClaim = await claimOrder(onTime.id, ALEX, { now: T });
      if (!onTimeClaim.ok) throw new Error("claim failed");
      const result = await submitVerification(
        onTime.id,
        { installerId: ALEX, claimToken: onTimeClaim.claimToken, outcome: "PASSED" },
        { now: at(CLAIM_TTL_MS - 1) },
      );
      expect(result.ok).toBe(true);
      const stored = await readRecord(onTime.id);
      expect(stored).toMatchObject({
        claimState: "CONFIRMED",
        claimInstallerId: ALEX,
        claimTokenHash: null,
        claimExpiresAt: null,
      });
      expect(stored.claimConfirmedAt?.toISOString()).toBe(at(CLAIM_TTL_MS - 1).toISOString());
    }));

  it("returns 409 CLAIM_EXPIRED from the API once the stored expiry has passed", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("api expired");
      const claim = await claimViaApi(order.id, { installerId: ALEX });
      await expireClaimNow(order.id);
      const before = await readRecord(order.id);

      const response = await verifyViaApi(order.id, {
        installerId: ALEX,
        claimToken: claim.body.claimToken,
        outcome: "PASSED",
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CLAIM_EXPIRED");
      expect(await readRecord(order.id)).toEqual(before);
    }));

  it("a confirmed claim never expires", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("confirmed stays");
      const claim = await claimOrder(order.id, ALEX, { now: T });
      if (!claim.ok) throw new Error("claim failed");
      await submitVerification(
        order.id,
        { installerId: ALEX, claimToken: claim.claimToken, outcome: "PASSED" },
        { now: at(1_000) },
      );
      const before = await readRecord(order.id);
      const muchLater = at(10 * 60 * 60 * 1000);

      expect(await claimOrder(order.id, SAM, { now: muchLater })).toEqual({ ok: false, reason: "ALREADY_CLAIMED" });
      const sweep = await releaseExpiredClaims(prisma, { now: muchLater });
      expect(sweep.released).not.toContain(order.id);
      expect(await readRecord(order.id)).toEqual(before);
    }));
});

describe("POST /api/orders/[id]/claim/verification", () => {
  it("PASSED confirms the claim and bumps the version", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("verify pass");
      const claim = await claimViaApi(order.id, { installerId: SAM });

      const response = await verifyViaApi(order.id, {
        installerId: SAM,
        claimToken: claim.body.claimToken,
        outcome: "PASSED",
      });

      expect(response.status).toBe(200);
      expect(response.body.order.claim).toMatchObject({ state: "CONFIRMED", installerId: SAM, expiresAt: null });
      expect(response.body.order.version).toBe(claim.body.order.version + 1);
    }));

  it("FAILED releases the claim back to the marketplace", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("verify fail");
      const claim = await claimViaApi(order.id, { installerId: SAM });

      const response = await verifyViaApi(order.id, {
        installerId: SAM,
        claimToken: claim.body.claimToken,
        outcome: "FAILED",
      });

      expect(response.status).toBe(200);
      expect(response.body.order.claim).toEqual({
        state: "NONE",
        installerId: null,
        expiresAt: null,
        claimedAt: null,
        confirmedAt: null,
      });
      expect((await readRecord(order.id)).claimTokenHash).toBeNull();
      expect((await claimViaApi(order.id, { installerId: JORDAN })).status).toBe(201);
    }));

  it.each([
    ["a wrong token", () => ({ installerId: ALEX, claimToken: randomToken(), outcome: "PASSED" })],
    ["a different installer", (token: string) => ({ installerId: SAM, claimToken: token, outcome: "PASSED" })],
    ["a different installer failing it", (token: string) => ({ installerId: SAM, claimToken: token, outcome: "FAILED" })],
  ])("ignores %s (409) and leaves the claim unchanged", (_label, makeBody) =>
    withTestRecords(async () => {
      const order = await createReadyOrder("verify mismatch");
      const claim = await claimViaApi(order.id, { installerId: ALEX });
      const before = await readRecord(order.id);

      const response = await verifyViaApi(order.id, makeBody(claim.body.claimToken));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CLAIM_NOT_ACTIVE");
      expect(await readRecord(order.id)).toEqual(before);
    }),
  );

  it("a stale token cannot confirm or release a newer claim, even by the same installer", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("stale token");
      const old = await claimOrder(order.id, ALEX, { now: T });
      const fresh = await claimOrder(order.id, ALEX, { now: at(CLAIM_TTL_MS + 1_000) });
      if (!old.ok || !fresh.ok) throw new Error("claims failed");
      const before = await readRecord(order.id);

      for (const outcome of ["PASSED", "FAILED"] as const) {
        const result = await submitVerification(
          order.id,
          { installerId: ALEX, claimToken: old.claimToken, outcome },
          { now: at(CLAIM_TTL_MS + 2_000) },
        );
        expect(result, outcome).toEqual({ ok: false, reason: "CLAIM_NOT_ACTIVE" });
      }
      expect(await readRecord(order.id)).toEqual(before);

      const ok = await submitVerification(
        order.id,
        { installerId: ALEX, claimToken: fresh.claimToken, outcome: "PASSED" },
        { now: at(CLAIM_TTL_MS + 3_000) },
      );
      expect(ok.ok).toBe(true);
    }));

  it.each([
    ["a malformed token", { installerId: ALEX, claimToken: "short", outcome: "PASSED" }],
    ["an unknown outcome", { installerId: ALEX, claimToken: "A".repeat(43), outcome: "MAYBE" }],
    ["an unknown installer", { installerId: "nobody", claimToken: "A".repeat(43), outcome: "PASSED" }],
    ["an unexpected field", { installerId: ALEX, claimToken: "A".repeat(43), outcome: "PASSED", now: 1 }],
  ])("rejects %s with 400", async (_label, body) => {
    const response = await verifyViaApi(missingId(), body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for a missing order", async () => {
    const response = await verifyViaApi(missingId(), {
      installerId: ALEX,
      claimToken: randomToken(),
      outcome: "PASSED",
    });
    expect(response.status).toBe(404);
  });
});

describe("expiry cleanup", () => {
  it("releases only expired pending claims", () =>
    withTestRecords(async () => {
      const expired = await createReadyOrder("cleanup expired");
      const confirmed = await createReadyOrder("cleanup confirmed");
      const renewed = await createReadyOrder("cleanup renewed");
      const active = await createReadyOrder("cleanup active");

      await claimOrder(expired.id, ALEX, { now: T });
      const c = await claimOrder(confirmed.id, ALEX, { now: T });
      if (!c.ok) throw new Error("claim failed");
      await submitVerification(confirmed.id, { installerId: ALEX, claimToken: c.claimToken, outcome: "PASSED" }, { now: at(1) });
      await claimOrder(renewed.id, ALEX, { now: T });
      await claimOrder(renewed.id, SAM, { now: at(CLAIM_TTL_MS + 5_000) }); // re-claimed after expiry
      await claimOrder(active.id, JORDAN, { now: at(CLAIM_TTL_MS) });
      const untouched = await Promise.all([confirmed, renewed, active].map((o) => readRecord(o.id)));
      const expiredBefore = await readRecord(expired.id);

      const sweep = await releaseExpiredClaims(prisma, { now: at(CLAIM_TTL_MS + 10_000) });

      expect(sweep.released).toContain(expired.id);
      for (const id of [confirmed.id, renewed.id, active.id]) expect(sweep.released).not.toContain(id);
      expect(await readRecord(expired.id)).toMatchObject({
        claimState: "NONE",
        claimInstallerId: null,
        claimTokenHash: null,
        claimExpiresAt: null,
        version: expiredBefore.version + 1,
      });
      expect(await Promise.all([confirmed, renewed, active].map((o) => readRecord(o.id)))).toEqual(untouched);
    }));

  it("does not release a claim that was replaced between its scan and its write", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("cleanup race");
      await claimOrder(order.id, ALEX, { now: T });
      const sweepTime = at(CLAIM_TTL_MS + 1_000);
      const newTokenHash = hashClaimToken(randomToken());

      // A runner that lets a new claim land right after the scan returns.
      const interleaved: CommandRunner = {
        $runCommandRaw: (async (command: Record<string, unknown>) => {
          const result = await prisma.$runCommandRaw(command as never);
          if ("find" in command) {
            expect(await tryClaim(prisma, { orderId: order.id, installerId: SAM, tokenHash: newTokenHash, now: sweepTime })).toBe(true);
          }
          return result;
        }) as CommandRunner["$runCommandRaw"],
      };

      const sweep = await releaseExpiredClaims(interleaved, { now: sweepTime });

      expect(sweep.candidates).toBeGreaterThanOrEqual(1);
      expect(sweep.released).not.toContain(order.id);
      expect(await readRecord(order.id)).toMatchObject({
        claimState: "PENDING_VERIFICATION",
        claimInstallerId: SAM,
        claimTokenHash: newTokenHash,
      });
    }));

  it("is safe when several cleanup processes run at once", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("cleanup parallel");
      await claimOrder(order.id, ALEX, { now: T });
      const before = await readRecord(order.id);
      const sweepTime = at(CLAIM_TTL_MS + 1_000);

      const sweeps = await Promise.all(
        Array.from({ length: 4 }, () => releaseExpiredClaims(prisma, { now: sweepTime })),
      );

      expect(sweeps.filter((s) => s.released.includes(order.id))).toHaveLength(1);
      expect(await readRecord(order.id)).toMatchObject({ claimState: "NONE", version: before.version + 1 });
    }));

  it("runs as a separate process (--once) with the real database clock", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("worker process");
      await claimViaApi(order.id, { installerId: ALEX });
      await expireClaimNow(order.id);

      const { stdout } = await promisify(execFile)(
        process.execPath,
        [path.resolve("scripts/claim-expiry-worker.mts"), "--once"],
        { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL } },
      );

      expect(stdout).toMatch(/single sweep: \d+ candidate\(s\), released [1-9]/);
      expect((await readRecord(order.id)).claimState).toBe("NONE");
    }));

  it("the worker loop sweeps periodically and stops cleanly when aborted", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("worker loop");
      await claimViaApi(order.id, { installerId: ALEX });
      await expireClaimNow(order.id);
      const controller = new AbortController();
      const logs: string[] = [];

      const running = runClaimExpiryWorker({
        db: prisma,
        intervalMs: 50,
        signal: controller.signal,
        log: (message) => logs.push(message),
      });
      await vi.waitFor(async () => expect((await readRecord(order.id)).claimState).toBe("NONE"), {
        timeout: 5_000,
      });
      controller.abort();

      await expect(running).resolves.toBeUndefined();
      expect(logs.some((line) => line.includes(order.id))).toBe(true);
    }));
});

describe("completing the order", () => {
  async function complete(id: string, expectedVersion: number) {
    return toJson<{ order: OrderDto } & ApiErrorBody>(
      await statusHandler(
        jsonRequest(`http://localhost/api/orders/${id}/status`, "PATCH", {
          targetStatus: "COMPLETED",
          expectedVersion,
        }),
        { params: Promise.resolve({ id }) },
      ),
    );
  }

  it("regression: releases a still-pending claim in the same write", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("complete releases pending");
      const claim = await claimViaApi(order.id, { installerId: ALEX });

      const completed = await complete(order.id, claim.body.order.version);

      expect(completed.status).toBe(200);
      expect(completed.body.order.claim).toEqual({
        state: "NONE",
        installerId: null,
        expiresAt: null,
        claimedAt: null,
        confirmedAt: null,
      });
      expect(await readRecord(order.id)).toMatchObject({ status: "COMPLETED", claimTokenHash: null });
      const late = await verifyViaApi(order.id, { installerId: ALEX, claimToken: claim.body.claimToken, outcome: "PASSED" });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe("CLAIM_NOT_ACTIVE");
    }));

  it("keeps a confirmed claim as the record of the assigned installer", () =>
    withTestRecords(async () => {
      const order = await createReadyOrder("complete keeps confirmed");
      const claim = await claimViaApi(order.id, { installerId: SAM });
      const verified = await verifyViaApi(order.id, { installerId: SAM, claimToken: claim.body.claimToken, outcome: "PASSED" });

      const completed = await complete(order.id, verified.body.order.version);

      expect(completed.body.order).toMatchObject({ status: "COMPLETED", claim: { state: "CONFIRMED", installerId: SAM } });
    }));

  it("completion and confirmation racing: the result is always consistent", () =>
    withTestRecords(async () => {
      for (let round = 0; round < 6; round++) {
        const order = await createReadyOrder(`complete race ${round}`);
        const claim = await claimViaApi(order.id, { installerId: ALEX });
        const [completed, verified] = await Promise.all([
          complete(order.id, claim.body.order.version),
          verifyViaApi(order.id, { installerId: ALEX, claimToken: claim.body.claimToken, outcome: "PASSED" }),
        ]);
        const stored = await readRecord(order.id);
        // Either the confirmation landed first (then completion lost on version)
        // or the completion did (then the pending claim was released).
        if (verified.status === 200) {
          expect(completed.status, `round ${round}`).toBe(409);
          expect(stored).toMatchObject({ status: "READY_FOR_INSTALL", claimState: "CONFIRMED" });
        } else {
          expect(completed.status, `round ${round}`).toBe(200);
          expect(stored).toMatchObject({ status: "COMPLETED", claimState: "NONE" });
        }
      }
    }));
});

describe("races between verification, cleanup and new claims", () => {
  it("expired claim: verification loses, the new claim always ends up active", () =>
    withTestRecords(async () => {
      for (let round = 0; round < 8; round++) {
        const order = await createReadyOrder(`race expired ${round}`);
        const old = await claimOrder(order.id, ALEX, { now: T });
        if (!old.ok) throw new Error("claim failed");
        const raceTime = at(CLAIM_TTL_MS + 1_000);

        const [verification, , fresh] = await Promise.all([
          submitVerification(order.id, { installerId: ALEX, claimToken: old.claimToken, outcome: "PASSED" }, { now: raceTime }),
          releaseExpiredClaims(prisma, { now: raceTime }),
          claimOrder(order.id, SAM, { now: raceTime }),
        ]);

        expect(verification.ok, `round ${round}`).toBe(false);
        expect(fresh.ok, `round ${round}`).toBe(true);
        const stored = await readRecord(order.id);
        expect(stored).toMatchObject({ claimState: "PENDING_VERIFICATION", claimInstallerId: SAM });
        expect(stored.claimTokenHash).toBe(hashClaimToken(fresh.ok ? fresh.claimToken : ""));
        expect(stored.claimExpiresAt?.toISOString()).toBe(new Date(raceTime.getTime() + CLAIM_TTL_MS).toISOString());
      }
    }));

  it("active claim: verification wins, the competing claim and cleanup do nothing", () =>
    withTestRecords(async () => {
      for (let round = 0; round < 8; round++) {
        const order = await createReadyOrder(`race active ${round}`);
        const claim = await claimOrder(order.id, ALEX, { now: T });
        if (!claim.ok) throw new Error("claim failed");
        const before = await readRecord(order.id);
        const raceTime = at(60_000);

        const [verification, sweep, competitor] = await Promise.all([
          submitVerification(order.id, { installerId: ALEX, claimToken: claim.claimToken, outcome: "PASSED" }, { now: raceTime }),
          releaseExpiredClaims(prisma, { now: raceTime }),
          claimOrder(order.id, SAM, { now: raceTime }),
        ]);

        expect(verification.ok, `round ${round}`).toBe(true);
        expect(competitor).toEqual({ ok: false, reason: "ALREADY_CLAIMED" });
        expect(sweep.released).not.toContain(order.id);
        expect(await readRecord(order.id)).toMatchObject({
          claimState: "CONFIRMED",
          claimInstallerId: ALEX,
          version: before.version + 1,
        });
      }
    }));

  it("PASSED and FAILED for the same claim: exactly one applies", () =>
    withTestRecords(async () => {
      for (let round = 0; round < 8; round++) {
        const order = await createReadyOrder(`race verdicts ${round}`);
        const claim = await claimOrder(order.id, ALEX, { now: T });
        if (!claim.ok) throw new Error("claim failed");
        const before = await readRecord(order.id);
        const body = { installerId: ALEX, claimToken: claim.claimToken };

        const results = await Promise.all([
          submitVerification(order.id, { ...body, outcome: "PASSED" }, { now: at(1_000) }),
          submitVerification(order.id, { ...body, outcome: "FAILED" }, { now: at(1_000) }),
        ]);

        expect(results.filter((r) => r.ok)).toHaveLength(1);
        const stored = await readRecord(order.id);
        expect(["CONFIRMED", "NONE"]).toContain(stored.claimState);
        expect(stored.version).toBe(before.version + 1);
      }
    }));
});
