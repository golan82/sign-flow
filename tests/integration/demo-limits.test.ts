// Demo data limits (src/lib/demo-limits.mts) against the real MongoDB test
// database: at most MAX_DEMO_ORDERS orders and MAX_UPLOAD_ATTEMPTS_PER_ORDER
// upload attempts per order, also under concurrent requests. Every created
// order/upload is tracked by id and deleted afterwards.
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { POST as authorizeHandler } from "@/app/api/orders/[id]/uploads/route";
import { MAX_DEMO_ORDERS, MAX_UPLOAD_ATTEMPTS_PER_ORDER } from "@/lib/demo-limits.mts";
import { createOrder } from "@/lib/orders/service";
import { prisma } from "@/lib/prisma";
import { abortUpload, authorizeUpload } from "@/lib/uploads/service";
import type { UploadAuthorization } from "@/lib/uploads/types";

import {
  createTestOrder,
  deleteTrackedRecords,
  jsonRequest,
  postOrder,
  testTitle,
  toJson,
  trackId,
  trackUploadId,
  withTestRecords,
} from "./helpers";

vi.mock("next/server", () => ({ connection: async () => {} }));

const pdf = (clientRequestId: string = randomUUID()) => ({
  clientRequestId,
  originalName: "storefront-banner.pdf",
  sizeBytes: 1_610_612_736,
  contentType: "application/pdf" as const,
});

async function authorize(orderId: string, body: unknown) {
  const response = await toJson<UploadAuthorization & { error: { code: string; message: string } }>(
    await authorizeHandler(jsonRequest(`http://localhost/api/orders/${orderId}/uploads`, "POST", body), {
      params: Promise.resolve({ id: orderId }),
    }),
  );
  if (response.status === 200 || response.status === 201) trackUploadId(response.body.upload.id);
  return response;
}

/** Creates tracked orders through the service until the database holds `total`. */
async function fillOrdersTo(total: number) {
  const missing = total - (await prisma.order.count());
  for (let i = 0; i < missing; i++) {
    const result = await createOrder({ title: testTitle(`filler ${i}`), description: undefined });
    if (!result.ok) throw new Error("filler order refused");
    trackId(result.order.id);
  }
}

const statuses = (responses: { status: number }[]) =>
  responses.map((response) => response.status).sort((a, b) => a - b);

afterAll(async () => {
  await deleteTrackedRecords();
  await prisma.$disconnect();
});

describe("order limit", () => {
  it("never exceeds the limit when many creations race for the last places", () =>
    withTestRecords(async () => {
      const limit = (await prisma.order.count()) + 3;
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => createOrder({ title: testTitle(`race ${i}`), description: undefined }, { maxOrders: limit })),
      );
      for (const result of results) if (result.ok) trackId(result.order.id);

      expect(results.filter((result) => result.ok)).toHaveLength(3);
      expect(results.filter((result) => !result.ok && result.reason === "DEMO_LIMIT_REACHED")).toHaveLength(9);
      expect(await prisma.order.count()).toBe(limit);
    }));

  it(`API: at ${MAX_DEMO_ORDERS} orders, exactly one of five parallel creations wins; deleting frees a place`, () =>
    withTestRecords(async () => {
      await fillOrdersTo(MAX_DEMO_ORDERS - 1);
      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, i) => postOrder({ title: testTitle(`last place ${i}`) })),
      );

      expect(statuses(responses)).toEqual([201, 409, 409, 409, 409]);
      const refused = responses.find((response) => response.status === 409)!;
      expect(refused.body.error.code).toBe("DEMO_LIMIT_REACHED");
      expect(refused.body.error).toMatchObject({ message: expect.stringContaining(`at most ${MAX_DEMO_ORDERS} orders`) });
      expect(await prisma.order.count()).toBe(MAX_DEMO_ORDERS);

      // The limit counts real orders, so a deletion (e.g. a manual reset) frees a place.
      const winner = responses.find((response) => response.status === 201)!;
      await prisma.order.delete({ where: { id: winner.body.order.id } });
      expect((await postOrder({ title: testTitle("after delete") })).status).toBe(201);
      expect(await prisma.order.count()).toBe(MAX_DEMO_ORDERS);
    }));
});

describe("upload attempt limit", () => {
  it(`never exceeds ${MAX_UPLOAD_ATTEMPTS_PER_ORDER} attempts per order under concurrent requests`, () =>
    withTestRecords(async () => {
      const order = await createTestOrder("upload limit race");
      const responses = await Promise.all(
        Array.from({ length: MAX_UPLOAD_ATTEMPTS_PER_ORDER + 10 }, () => authorize(order.id, pdf())),
      );

      expect(responses.filter((response) => response.status === 201)).toHaveLength(MAX_UPLOAD_ATTEMPTS_PER_ORDER);
      const refused = responses.filter((response) => response.status === 409);
      expect(refused).toHaveLength(10);
      expect(refused.every((response) => response.body.error.code === "DEMO_LIMIT_REACHED")).toBe(true);
      expect(refused[0].body.error.message).toContain(`at most ${MAX_UPLOAD_ATTEMPTS_PER_ORDER} upload attempts`);
      expect(await prisma.upload.count({ where: { orderId: order.id } })).toBe(MAX_UPLOAD_ATTEMPTS_PER_ORDER);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).uploadRequestIds).toHaveLength(
        MAX_UPLOAD_ATTEMPTS_PER_ORDER,
      );
    }));

  it("repeating a request for an existing attempt takes no extra place, also at the limit", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("upload limit idempotency");
      for (let i = 0; i < MAX_UPLOAD_ATTEMPTS_PER_ORDER - 1; i++) {
        expect((await authorize(order.id, pdf())).status).toBe(201);
      }
      // The last place: the same request five times at once (a double click).
      const last = pdf();
      const repeats = await Promise.all(Array.from({ length: 5 }, () => authorize(order.id, last)));
      expect(repeats.every((response) => response.status === 200 || response.status === 201)).toBe(true);
      expect(new Set(repeats.map((response) => response.body.upload.id)).size).toBe(1);
      expect(repeats.filter((response) => response.status === 201)).toHaveLength(1);

      // At the limit: the same request still returns its attempt; a new one is refused.
      const again = await authorize(order.id, last);
      expect(again.status).toBe(200);
      expect(again.body.upload.id).toBe(repeats[0].body.upload.id);
      const fresh = await authorize(order.id, pdf());
      expect(fresh.status).toBe(409);
      expect(fresh.body.error.code).toBe("DEMO_LIMIT_REACHED");
      expect(await prisma.upload.count({ where: { orderId: order.id } })).toBe(MAX_UPLOAD_ATTEMPTS_PER_ORDER);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).uploadRequestIds).toHaveLength(
        MAX_UPLOAD_ATTEMPTS_PER_ORDER,
      );
    }));

  it("failed and cancelled attempts count against the limit", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("upload limit outcomes");
      for (const reason of ["CANCELLED", "FAILED"] as const) {
        const issued = await authorizeUpload(order.id, pdf(), { maxAttempts: 2 });
        if (!issued.ok) throw new Error("authorization refused");
        trackUploadId(issued.authorization.upload.id);
        const { upload, uploadUrl } = issued.authorization;
        expect((await abortUpload(order.id, upload.id, uploadUrl, reason)).ok).toBe(true);
      }
      expect(await authorizeUpload(order.id, pdf(), { maxAttempts: 2 })).toEqual({
        ok: false,
        reason: "DEMO_LIMIT_REACHED",
        limit: 2,
      });
    }));
});
