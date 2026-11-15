// Vendor assignment (PATCH /api/orders/[id]/vendor) and the vendor rule for
// VENDOR_ACCEPTED, against the real MongoDB test database.
import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { PATCH as statusHandler } from "@/app/api/orders/[id]/status/route";
import { PATCH as vendorHandler } from "@/app/api/orders/[id]/vendor/route";
import type { ApiErrorBody, OrderDto } from "@/lib/orders/types";
import { prisma } from "@/lib/prisma";

import {
  createTestOrder,
  deleteTrackedRecords,
  jsonRequest,
  readRecord,
  setStatusDirectly,
  toJson,
  withTestRecords,
} from "./helpers";

vi.mock("next/server", () => ({ connection: async () => {} }));

type Body = { order: OrderDto } & ApiErrorBody;

async function patchVendor(id: string, body: unknown) {
  return toJson<Body>(
    await vendorHandler(jsonRequest(`http://localhost/api/orders/${id}/vendor`, "PATCH", body), {
      params: Promise.resolve({ id }),
    }),
  );
}

async function patchStatus(id: string, body: unknown) {
  return toJson<Body>(
    await statusHandler(jsonRequest(`http://localhost/api/orders/${id}/status`, "PATCH", body), {
      params: Promise.resolve({ id }),
    }),
  );
}

afterAll(async () => {
  await deleteTrackedRecords();
  await prisma.$disconnect();
});

describe("PATCH /api/orders/[id]/vendor", () => {
  it("assigns, changes and removes the vendor while DRAFT/SUBMITTED, bumping the version", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("vendor assign");

      const assigned = await patchVendor(order.id, { vendorId: "vendor-metro", expectedVersion: 0 });
      expect(assigned.status).toBe(200);
      expect(assigned.body.order).toMatchObject({ vendorId: "vendor-metro", version: 1 });

      expect((await patchStatus(order.id, { targetStatus: "SUBMITTED", expectedVersion: 1 })).status).toBe(200);
      const changed = await patchVendor(order.id, { vendorId: "vendor-coastal", expectedVersion: 2 });
      expect(changed.body.order).toMatchObject({ vendorId: "vendor-coastal", version: 3, status: "SUBMITTED" });

      const removed = await patchVendor(order.id, { vendorId: null, expectedVersion: 3 });
      expect(removed.body.order).toMatchObject({ vendorId: null, version: 4 });
      expect((await readRecord(order.id)).vendorId).toBeNull();
    }));

  it("requires a vendor before VENDOR_ACCEPTED and locks it afterwards", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("vendor rule");
      await patchStatus(order.id, { targetStatus: "SUBMITTED", expectedVersion: 0 });
      const before = await readRecord(order.id);

      const refused = await patchStatus(order.id, { targetStatus: "VENDOR_ACCEPTED", expectedVersion: 1 });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe("VENDOR_REQUIRED");
      expect(await readRecord(order.id)).toEqual(before);

      await patchVendor(order.id, { vendorId: "vendor-brightline", expectedVersion: 1 });
      const accepted = await patchStatus(order.id, { targetStatus: "VENDOR_ACCEPTED", expectedVersion: 2 });
      expect(accepted.status).toBe(200);
      const lockedBefore = await readRecord(order.id);

      const locked = await patchVendor(order.id, { vendorId: "vendor-metro", expectedVersion: 3 });
      expect(locked.status).toBe(400);
      expect(locked.body.error.code).toBe("VENDOR_LOCKED");
      expect(await readRecord(order.id)).toEqual(lockedBefore);
    }));

  it("rejects a stale version with 409; of two concurrent changes exactly one wins", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("vendor conflict");
      await patchVendor(order.id, { vendorId: "vendor-metro", expectedVersion: 0 });
      const stale = await patchVendor(order.id, { vendorId: "vendor-coastal", expectedVersion: 0 });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe("VERSION_CONFLICT");

      const both = await Promise.all([
        patchVendor(order.id, { vendorId: "vendor-coastal", expectedVersion: 1 }),
        patchVendor(order.id, { vendorId: "vendor-brightline", expectedVersion: 1 }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = both.find((r) => r.status === 200)!;
      expect(await readRecord(order.id)).toMatchObject({ vendorId: winner.body.order.vendorId, version: 2 });
    }));

  it("never ends up VENDOR_ACCEPTED without a vendor when removal and acceptance race", () =>
    withTestRecords(async () => {
      for (let round = 0; round < 6; round++) {
        const order = await createTestOrder(`vendor race ${round}`);
        await patchVendor(order.id, { vendorId: "vendor-metro", expectedVersion: 0 });
        await patchStatus(order.id, { targetStatus: "SUBMITTED", expectedVersion: 1 });

        const [removal, acceptance] = await Promise.all([
          patchVendor(order.id, { vendorId: null, expectedVersion: 2 }),
          patchStatus(order.id, { targetStatus: "VENDOR_ACCEPTED", expectedVersion: 2 }),
        ]);

        expect([removal.status, acceptance.status].filter((s) => s === 200), `round ${round}`).toHaveLength(1);
        const stored = await readRecord(order.id);
        if (stored.status === "VENDOR_ACCEPTED") expect(stored.vendorId).toBe("vendor-metro");
        else expect(stored).toMatchObject({ status: "SUBMITTED", vendorId: null });
        expect(stored.version).toBe(3);
      }
    }));

  it.each([
    ["an unknown vendor", { vendorId: "vendor-acme", expectedVersion: 0 }],
    ["a missing version", { vendorId: "vendor-metro" }],
    ["an unexpected field", { vendorId: "vendor-metro", expectedVersion: 0, status: "COMPLETED" }],
  ])("rejects %s with 400", (_label, body) =>
    withTestRecords(async () => {
      const order = await createTestOrder("vendor validation");
      const before = await readRecord(order.id);
      const response = await patchVendor(order.id, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(await readRecord(order.id)).toEqual(before);
    }),
  );

  it("returns 404 for a missing order and 400 for a final order", () =>
    withTestRecords(async () => {
      const missing = await patchVendor(randomBytes(12).toString("hex"), { vendorId: null, expectedVersion: 0 });
      expect(missing.status).toBe(404);
      const order = await createTestOrder("vendor final");
      await setStatusDirectly(order.id, "CANCELLED");
      expect((await patchVendor(order.id, { vendorId: "vendor-metro", expectedVersion: 0 })).body.error.code).toBe(
        "VENDOR_LOCKED",
      );
    }));
});
