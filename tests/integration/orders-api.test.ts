// Integration tests: Route Handlers -> service -> Prisma -> the real local
// MongoDB replica set, test database only (TEST_DATABASE_URL, enforced by
// setup.ts). Every test tracks the ids it creates and deletes only those ids
// in `finally`.
import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { PATCH } from "@/app/api/orders/[id]/status/route";
import { GET } from "@/app/api/orders/route";
import type { OrderStatus } from "@/lib/orders/status";
import type { ApiErrorBody, OrderDto } from "@/lib/orders/types";
import { prisma } from "@/lib/prisma";

import {
  createTestOrder,
  deleteTrackedRecords,
  jsonRequest,
  postOrder,
  readRecord,
  setVendorDirectly,
  testTitle,
  toJson,
  withTestRecords,
} from "./helpers";

// connection() only works inside a Next.js request scope. Here the handlers
// are called directly, so it becomes a no-op; its effect (no prerendering of
// GET /api/orders) is covered by `npm run build`.
vi.mock("next/server", () => ({ connection: async () => {} }));

const BASE_URL = "http://localhost/api/orders";

async function patchStatus(id: string, body: unknown, rawBody?: string) {
  return toJson<{ order: OrderDto } & ApiErrorBody>(
    await PATCH(jsonRequest(`${BASE_URL}/${id}/status`, "PATCH", body, rawBody), {
      params: Promise.resolve({ id }),
    }),
  );
}

const missingId = () => randomBytes(12).toString("hex");

afterAll(async () => {
  await deleteTrackedRecords();
  await prisma.$disconnect();
});

describe("POST /api/orders", () => {
  it("creates an order in DRAFT with version 0", () =>
    withTestRecords(async () => {
      const response = await postOrder({
        title: `  ${testTitle("create")}  `,
        description: "  Lightbox sign, 2m x 1m  ",
      });

      expect(response.status).toBe(201);
      const { order } = response.body;
      expect(order).toMatchObject({
        title: testTitle("create"),
        description: "Lightbox sign, 2m x 1m",
        status: "DRAFT",
        version: 0,
      });
      expect(order.id).toMatch(/^[0-9a-f]{24}$/);

      const stored = await readRecord(order.id);
      expect(stored).toMatchObject({ status: "DRAFT", version: 0, title: testTitle("create") });
    }));

  it.each([
    ["status", { status: "COMPLETED" }],
    ["version", { version: 7 }],
    ["an unknown field", { priority: "high" }],
  ])("rejects a body that sets %s", (_label, extra) =>
    withTestRecords(async () => {
      const title = testTitle(`extra ${_label}`);
      const response = await postOrder({ title, ...extra });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(await prisma.order.count({ where: { title } })).toBe(0);
    }));

  it.each([
    ["a blank title", { title: "   " }],
    ["a missing title", {}],
    ["a 121-character title", { title: "a".repeat(121) }],
    ["a 2001-character description", { title: "ok", description: "d".repeat(2001) }],
    ["a non-object body", ["not", "an", "object"]],
  ])("rejects %s with 400", async (_label, body) => {
    const response = await postOrder(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await postOrder(undefined, '{"title": ');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_JSON");
  });
});

describe("GET /api/orders", () => {
  it("lists orders newest first and is never cacheable", () =>
    withTestRecords(async () => {
      const first = await createTestOrder("older");
      const second = await createTestOrder("newer");

      const response = await toJson<{ orders: OrderDto[] }>(await GET());
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");

      const ids = response.body.orders.map((order) => order.id);
      expect(ids).toContain(first.id);
      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    }));

  it("returns a generic 500 without internal details when the database fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const findMany = vi
      .spyOn(prisma.order, "findMany")
      .mockRejectedValueOnce(new Error("secret connection string mongodb://internal"));
    try {
      const response = await toJson<ApiErrorBody>(await GET());
      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(response.body)).not.toContain("secret");
      expect(consoleError).toHaveBeenCalled();
    } finally {
      findMany.mockRestore();
      consoleError.mockRestore();
    }
  });
});

describe("PATCH /api/orders/[id]/status", () => {
  it("applies a valid transition and increments the version", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("valid transition");

      const response = await patchStatus(order.id, { targetStatus: "SUBMITTED", expectedVersion: 0 });

      expect(response.status).toBe(200);
      expect(response.body.order).toMatchObject({ id: order.id, status: "SUBMITTED", version: 1 });
      const stored = await readRecord(order.id);
      expect(stored).toMatchObject({ status: "SUBMITTED", version: 1 });
      expect(stored.updatedAt.getTime()).toBeGreaterThanOrEqual(new Date(order.updatedAt).getTime());
    }));

  it("walks the full lifecycle one step at a time", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("lifecycle");
      await setVendorDirectly(order.id); // required before VENDOR_ACCEPTED
      const steps: OrderStatus[] = [
        "SUBMITTED",
        "VENDOR_ACCEPTED",
        "IN_PRODUCTION",
        "READY_FOR_INSTALL",
        "COMPLETED",
      ];
      for (const [index, targetStatus] of steps.entries()) {
        const response = await patchStatus(order.id, { targetStatus, expectedVersion: index });
        expect(response.status, targetStatus).toBe(200);
        expect(response.body.order).toMatchObject({ status: targetStatus, version: index + 1 });
      }
    }));

  it.each<[string, OrderStatus[], OrderStatus]>([
    ["skipping a step", [], "IN_PRODUCTION"],
    ["moving backwards", ["SUBMITTED"], "DRAFT"],
    ["a same-status transition", [], "DRAFT"],
    ["cancelling after production started", ["SUBMITTED", "VENDOR_ACCEPTED", "IN_PRODUCTION"], "CANCELLED"],
    ["leaving CANCELLED", ["CANCELLED"], "SUBMITTED"],
  ])("rejects %s with 400 and leaves the document unchanged", (label, setup, target) =>
    withTestRecords(async () => {
      const order = await createTestOrder(label);
      await setVendorDirectly(order.id);
      for (const [index, step] of setup.entries()) {
        expect((await patchStatus(order.id, { targetStatus: step, expectedVersion: index })).status).toBe(200);
      }
      const before = await readRecord(order.id);

      const response = await patchStatus(order.id, {
        targetStatus: target,
        expectedVersion: before.version,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("INVALID_TRANSITION");
      expect(await readRecord(order.id)).toEqual(before);
    }));

  it("rejects a stale expectedVersion with 409 and leaves the document unchanged", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("stale version");
      expect((await patchStatus(order.id, { targetStatus: "SUBMITTED", expectedVersion: 0 })).status).toBe(200);
      const before = await readRecord(order.id);

      const response = await patchStatus(order.id, { targetStatus: "VENDOR_ACCEPTED", expectedVersion: 0 });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("VERSION_CONFLICT");
      expect(await readRecord(order.id)).toEqual(before);
    }));

  it("lets exactly one of two concurrent requests with the same version succeed", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("concurrent pair");

      const responses = await Promise.all([
        patchStatus(order.id, { targetStatus: "SUBMITTED", expectedVersion: 0 }),
        patchStatus(order.id, { targetStatus: "CANCELLED", expectedVersion: 0 }),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = responses.find((r) => r.status === 200)!;
      const stored = await readRecord(order.id);
      expect(stored.version).toBe(1);
      expect(stored.status).toBe(winner.body.order.status);
    }));

  it("lets exactly one of ten concurrent requests with the same version succeed", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("concurrent burst");

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          patchStatus(order.id, { targetStatus: "SUBMITTED", expectedVersion: 0 }),
        ),
      );

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(9);
      expect(await readRecord(order.id)).toMatchObject({ status: "SUBMITTED", version: 1 });
    }));

  it("returns 409 when the order changes between the read and the conditional write", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("lost race");
      const staleSnapshot = await readRecord(order.id);
      // Another request wins the race first...
      expect((await patchStatus(order.id, { targetStatus: "SUBMITTED", expectedVersion: 0 })).status).toBe(200);
      const before = await readRecord(order.id);

      // ...while this request's read still sees the old document.
      const findUnique = vi.spyOn(prisma.order, "findUnique").mockResolvedValueOnce(staleSnapshot);
      try {
        const response = await patchStatus(order.id, { targetStatus: "CANCELLED", expectedVersion: 0 });
        expect(findUnique).toHaveBeenCalled();
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe("VERSION_CONFLICT");
      } finally {
        findUnique.mockRestore();
      }
      expect(await readRecord(order.id)).toEqual(before);
    }));

  it("returns 404 for a well-formed id that does not exist", async () => {
    const response = await patchStatus(missingId(), { targetStatus: "SUBMITTED", expectedVersion: 0 });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for an id that is not an ObjectId", async () => {
    const response = await patchStatus("not-an-object-id", { targetStatus: "SUBMITTED", expectedVersion: 0 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await patchStatus(missingId(), undefined, "{oops");
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_JSON");
  });

  it.each([
    ["an unknown status", { targetStatus: "SHIPPED", expectedVersion: 0 }],
    ["a missing expectedVersion", { targetStatus: "SUBMITTED" }],
    ["a string expectedVersion", { targetStatus: "SUBMITTED", expectedVersion: "0" }],
    ["a negative expectedVersion", { targetStatus: "SUBMITTED", expectedVersion: -1 }],
    ["an unexpected field", { targetStatus: "SUBMITTED", expectedVersion: 0, version: 3 }],
  ])("returns 400 for %s and leaves the document unchanged", (label, body) =>
    withTestRecords(async () => {
      const order = await createTestOrder(label);
      const before = await readRecord(order.id);

      const response = await patchStatus(order.id, body);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(await readRecord(order.id)).toEqual(before);
    }));
});
