// Upload authorization, signed URLs, completion and abort against the real
// MongoDB test database. Every created order/upload is tracked by id and
// deleted in `finally`.
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { POST as abortHandler } from "@/app/api/orders/[id]/uploads/[uploadId]/abort/route";
import { POST as completeHandler } from "@/app/api/orders/[id]/uploads/[uploadId]/complete/route";
import { POST as authorizeHandler } from "@/app/api/orders/[id]/uploads/route";
import { GET as listHandler } from "@/app/api/orders/route";
import type { OrderDto } from "@/lib/orders/types";
import { prisma } from "@/lib/prisma";
import { UPLOAD_AUTHORIZATION_TTL_MS } from "@/lib/uploads/constants";
import { authorizeUpload, completeUpload } from "@/lib/uploads/service";
import type { UploadAuthorization, UploadDto } from "@/lib/uploads/types";

import {
  createTestOrder,
  deleteTrackedRecords,
  jsonRequest,
  setStatusDirectly,
  toJson,
  trackUploadId,
  withTestRecords,
} from "./helpers";

vi.mock("next/server", () => ({ connection: async () => {} }));

const GIB = 1024 ** 3;
const pdf = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: randomUUID(),
  originalName: "storefront-banner.pdf",
  sizeBytes: Math.round(1.5 * GIB),
  contentType: "application/pdf" as const,
  ...overrides,
});
type ErrorBody = { error: { code: string } };
type ActionBody = { upload: UploadDto; changed: boolean } & ErrorBody;

async function authorize(orderId: string, body: unknown) {
  const response = await toJson<UploadAuthorization & ErrorBody>(
    await authorizeHandler(jsonRequest(`http://localhost/api/orders/${orderId}/uploads`, "POST", body), {
      params: Promise.resolve({ id: orderId }),
    }),
  );
  if (response.status === 200 || response.status === 201) trackUploadId(response.body.upload.id);
  return response;
}

async function complete(orderId: string, uploadId: string, uploadUrl: string) {
  return toJson<ActionBody>(
    await completeHandler(
      jsonRequest(`http://localhost/api/orders/${orderId}/uploads/${uploadId}/complete`, "POST", { uploadUrl }),
      { params: Promise.resolve({ id: orderId, uploadId }) },
    ),
  );
}

async function abort(orderId: string, uploadId: string, uploadUrl: string, reason: "CANCELLED" | "FAILED") {
  return toJson<ActionBody>(
    await abortHandler(
      jsonRequest(`http://localhost/api/orders/${orderId}/uploads/${uploadId}/abort`, "POST", { uploadUrl, reason }),
      { params: Promise.resolve({ id: orderId, uploadId }) },
    ),
  );
}

async function authorizedUpload(label: string) {
  const order = await createTestOrder(label);
  const response = await authorize(order.id, pdf());
  expect(response.status).toBe(201);
  return { order, auth: response.body };
}

const readUpload = (id: string) => prisma.upload.findUniqueOrThrow({ where: { id } });
const missingId = () => randomBytes(12).toString("hex");

afterAll(async () => {
  await deleteTrackedRecords();
  await prisma.$disconnect();
});

describe("POST /api/orders/[id]/uploads (authorization)", () => {
  it("creates a pending upload and returns a signed URL with a server-generated key", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("authorize");
      const response = await authorize(order.id, pdf({ originalName: "Storefront Banner.pdf" }));

      expect(response.status).toBe(201);
      const { upload, uploadUrl, expiresAt } = response.body;
      expect(upload).toMatchObject({
        originalName: "Storefront Banner.pdf",
        sizeBytes: Math.round(1.5 * GIB),
        contentType: "application/pdf",
        status: "PENDING_UPLOAD",
        completedAt: null,
      });
      expect(Date.parse(expiresAt) - Date.parse(upload.createdAt)).toBeGreaterThan(UPLOAD_AUTHORIZATION_TTL_MS - 5_000);

      const url = new URL(uploadUrl);
      expect(url.origin).toBe("https://simulated-storage.invalid");
      expect(url.searchParams.get("X-Upload-Id")).toBe(upload.id);
      expect(url.searchParams.get("X-Signature")).toBeTruthy();
      const stored = await readUpload(upload.id);
      expect(stored.storageKey).toMatch(new RegExp(`^orders/${order.id}/${upload.id}/[0-9a-f]{24}\\.pdf$`));
      expect(stored.storageKey).not.toContain("Banner");
      expect(stored.sizeBytes).toBe(BigInt(Math.round(1.5 * GIB)));

      // The list shows metadata only: no URL, signature, storage key or request id.
      const list = await toJson<{ orders: OrderDto[] }>(await listHandler());
      const listed = list.body.orders.find((o) => o.id === order.id)!;
      expect(listed.uploads.map((u) => u.id)).toEqual([upload.id]);
      const raw = JSON.stringify(list.body);
      for (const secret of [uploadUrl, url.searchParams.get("X-Signature")!, stored.storageKey, stored.clientRequestId]) {
        expect(raw).not.toContain(secret);
      }
    }));

  it("is idempotent per clientRequestId (a double click creates one upload)", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("idempotent");
      const body = pdf();

      const responses = await Promise.all([authorize(order.id, body), authorize(order.id, body)]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
      expect(new Set(responses.map((r) => r.body.upload.id)).size).toBe(1);
      expect(responses[0].body.uploadUrl).toBe(responses[1].body.uploadUrl);
      expect(await prisma.upload.count({ where: { orderId: order.id } })).toBe(1);

      const conflict = await authorize(order.id, { ...body, sizeBytes: 10 });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    }));

  it.each([
    ["too large", { sizeBytes: 5 * GIB + 1 }],
    ["empty", { sizeBytes: 0 }],
    ["a path in the name", { originalName: "../../secrets.pdf" }],
    ["a mismatching extension", { originalName: "banner.exe" }],
    ["an unsupported type", { contentType: "text/html", originalName: "x.html" }],
    ["a client-chosen storage key", { storageKey: "orders/x/evil.pdf" }],
    ["a client-chosen status", { status: "COMPLETED" }],
  ])("rejects a request that is %s with 400", (_label, overrides) =>
    withTestRecords(async () => {
      const order = await createTestOrder("authorize invalid");
      const response = await authorize(order.id, pdf(overrides));
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(await prisma.upload.count({ where: { orderId: order.id } })).toBe(0);
    }),
  );

  it("returns 404 for a missing order and 400 for completed or cancelled orders", () =>
    withTestRecords(async () => {
      expect((await authorize(missingId(), pdf())).status).toBe(404);
      for (const status of ["COMPLETED", "CANCELLED"] as const) {
        const order = await createTestOrder(`final ${status}`);
        await setStatusDirectly(order.id, status);
        const response = await authorize(order.id, pdf());
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("ORDER_NOT_UPLOADABLE");
      }
    }));
});

describe("completion and abort", () => {
  it("completes once; repeating the completion is idempotent", () =>
    withTestRecords(async () => {
      const { order, auth } = await authorizedUpload("complete");

      const first = await complete(order.id, auth.upload.id, auth.uploadUrl);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ changed: true, upload: { status: "COMPLETED" } });
      const stored = await readUpload(auth.upload.id);
      expect(stored.completedAt).not.toBeNull();

      const again = await complete(order.id, auth.upload.id, auth.uploadUrl);
      expect(again.status).toBe(200);
      expect(again.body.changed).toBe(false);
      expect(await readUpload(auth.upload.id)).toEqual(stored);
    }));

  it.each([
    ["X-Size", "1"],
    ["X-Content-Type", "image/png"],
    ["X-Expires", String(Date.now() + 10 * 365 * 24 * 3600 * 1000)],
    ["X-Signature", "forged"],
  ])("rejects a URL with a modified %s (403) and changes nothing", (param, value) =>
    withTestRecords(async () => {
      const { order, auth } = await authorizedUpload("tampered");
      const before = await readUpload(auth.upload.id);
      const url = new URL(auth.uploadUrl);
      url.searchParams.set(param, value);

      const response = await complete(order.id, auth.upload.id, url.toString());

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("UPLOAD_SIGNATURE_INVALID");
      expect(await readUpload(auth.upload.id)).toEqual(before);
    }),
  );

  it("does not let one upload's URL complete or cancel another upload (swapped ids)", () =>
    withTestRecords(async () => {
      const { order, auth: a } = await authorizedUpload("swap");
      const b = (await authorize(order.id, pdf({ originalName: "other.pdf" }))).body;
      const other = await authorizedUpload("swap other order");
      const before = await Promise.all([a, b, other.auth].map((x) => readUpload(x.upload.id)));

      const attempts = [
        await complete(order.id, b.upload.id, a.uploadUrl), // B's path, A's signature
        await abort(order.id, b.upload.id, a.uploadUrl, "CANCELLED"),
        await complete(other.order.id, a.upload.id, a.uploadUrl), // other order in the path
        await complete(order.id, other.auth.upload.id, other.auth.uploadUrl), // upload of another order
      ];

      for (const attempt of attempts) {
        expect(attempt.status).toBe(403);
        expect(attempt.body.error.code).toBe("UPLOAD_SIGNATURE_INVALID");
      }
      expect(await Promise.all([a, b, other.auth].map((x) => readUpload(x.upload.id)))).toEqual(before);
    }));

  it("rejects completion and abort once the authorization has expired", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("expired");
      // Dedicated test authorization issued in the past, so it is already expired.
      const issued = await authorizeUpload(order.id, pdf(), {
        now: new Date(Date.now() - UPLOAD_AUTHORIZATION_TTL_MS - 60_000),
      });
      if (!issued.ok) throw new Error("authorization failed");
      const { upload, uploadUrl } = issued.authorization;
      trackUploadId(upload.id);
      const before = await readUpload(upload.id);

      for (const response of [
        await complete(order.id, upload.id, uploadUrl),
        await abort(order.id, upload.id, uploadUrl, "CANCELLED"),
      ]) {
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe("UPLOAD_EXPIRED");
      }
      expect(await readUpload(upload.id)).toEqual(before);
    }));

  it("accepts completion just before expiry and refuses it at the expiry instant", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("expiry boundary");
      const t = new Date("2031-01-01T00:00:00.000Z");
      const late = await authorizeUpload(order.id, pdf(), { now: t });
      const onTime = await authorizeUpload(order.id, pdf(), { now: t });
      if (!late.ok || !onTime.ok) throw new Error("authorization failed");
      trackUploadId(late.authorization.upload.id);
      trackUploadId(onTime.authorization.upload.id);
      const expiry = new Date(t.getTime() + UPLOAD_AUTHORIZATION_TTL_MS);

      expect(
        await completeUpload(order.id, late.authorization.upload.id, late.authorization.uploadUrl, { now: expiry }),
      ).toEqual({ ok: false, reason: "EXPIRED" });
      const ok = await completeUpload(order.id, onTime.authorization.upload.id, onTime.authorization.uploadUrl, {
        now: new Date(expiry.getTime() - 1),
      });
      expect(ok).toMatchObject({ ok: true, changed: true });
    }));

  it("cancel is idempotent; completion after cancel and cancel after completion are refused", () =>
    withTestRecords(async () => {
      const { order, auth: cancelled } = await authorizedUpload("cancel");
      expect((await abort(order.id, cancelled.upload.id, cancelled.uploadUrl, "CANCELLED")).body).toMatchObject({
        changed: true,
        upload: { status: "CANCELLED" },
      });
      const again = await abort(order.id, cancelled.upload.id, cancelled.uploadUrl, "CANCELLED");
      expect(again.status).toBe(200);
      expect(again.body.changed).toBe(false);
      const late = await complete(order.id, cancelled.upload.id, cancelled.uploadUrl);
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe("UPLOAD_CANCELLED");
      expect((await readUpload(cancelled.upload.id)).status).toBe("CANCELLED");

      const done = (await authorize(order.id, pdf())).body;
      await complete(order.id, done.upload.id, done.uploadUrl);
      const cancelAfter = await abort(order.id, done.upload.id, done.uploadUrl, "CANCELLED");
      expect(cancelAfter.status).toBe(409);
      expect(cancelAfter.body.error.code).toBe("UPLOAD_ALREADY_COMPLETED");
      expect((await readUpload(done.upload.id)).status).toBe("COMPLETED");
    }));

  it("a request for an old attempt cannot change the new attempt", () =>
    withTestRecords(async () => {
      const { order, auth: first } = await authorizedUpload("retry");
      await abort(order.id, first.upload.id, first.uploadUrl, "FAILED");
      const retry = (await authorize(order.id, pdf())).body; // "Try again": new attempt
      const retryBefore = await readUpload(retry.upload.id);

      const stale = await complete(order.id, first.upload.id, first.uploadUrl);
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe("UPLOAD_FAILED");
      expect(await readUpload(retry.upload.id)).toEqual(retryBefore);

      expect((await complete(order.id, retry.upload.id, retry.uploadUrl)).status).toBe(200);
    }));

  it("simultaneous completion and cancellation: exactly one wins", () =>
    withTestRecords(async () => {
      for (let round = 0; round < 6; round++) {
        const { order, auth } = await authorizedUpload(`race ${round}`);
        const [completed, cancelled] = await Promise.all([
          complete(order.id, auth.upload.id, auth.uploadUrl),
          abort(order.id, auth.upload.id, auth.uploadUrl, "CANCELLED"),
        ]);
        const winners = [completed, cancelled].filter((r) => r.status === 200);
        expect(winners, `round ${round}`).toHaveLength(1);
        expect((await readUpload(auth.upload.id)).status).toBe(winners[0].body.upload.status);
      }
    }));

  it("documented behavior: an attempt authorized before the order became final may still finish; new ones are refused", () =>
    withTestRecords(async () => {
      const { order, auth } = await authorizedUpload("final after authorize");
      await setStatusDirectly(order.id, "COMPLETED");

      const refused = await authorize(order.id, pdf());
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe("ORDER_NOT_UPLOADABLE");

      const finished = await complete(order.id, auth.upload.id, auth.uploadUrl);
      expect(finished.status).toBe(200);
      expect(finished.body.upload.status).toBe("COMPLETED");
    }));

  it("returns 404 for an unknown upload with a validly shaped request", () =>
    withTestRecords(async () => {
      const { order, auth } = await authorizedUpload("missing upload");
      await prisma.upload.delete({ where: { id: auth.upload.id } });
      const response = await complete(order.id, auth.upload.id, auth.uploadUrl);
      expect(response.status).toBe(404);
    }));
});
