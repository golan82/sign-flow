// Shared helpers for integration tests. Every record a test creates is
// tracked by id, and cleanup deletes exactly those ids, never a collection.
import { randomUUID } from "node:crypto";

import { POST as postOrderHandler } from "@/app/api/orders/route";
import type { OrderDto } from "@/lib/orders/types";
import { prisma } from "@/lib/prisma";

export const RUN_PREFIX = `it ${randomUUID()}`;
export const testTitle = (label: string) => `${RUN_PREFIX} ${label}`;

const trackedIds = new Set<string>();
const trackedUploadIds = new Set<string>();

export function trackId(id: string) {
  trackedIds.add(id);
}

export function trackUploadId(id: string) {
  trackedUploadIds.add(id);
}

export async function deleteTrackedRecords() {
  if (trackedUploadIds.size > 0) {
    const uploadIds = [...trackedUploadIds];
    await prisma.upload.deleteMany({ where: { id: { in: uploadIds } } });
    for (const id of uploadIds) trackedUploadIds.delete(id);
  }
  if (trackedIds.size === 0) return;
  const ids = [...trackedIds];
  await prisma.order.deleteMany({ where: { id: { in: ids } } });
  for (const id of ids) trackedIds.delete(id);
}

/** Runs a test body and always deletes the records it created. */
export async function withTestRecords(run: () => Promise<void>) {
  try {
    await run();
  } finally {
    await deleteTrackedRecords();
  }
}

export type JsonResponse<T> = { status: number; headers: Headers; body: T };

export async function toJson<T>(response: Response): Promise<JsonResponse<T>> {
  return { status: response.status, headers: response.headers, body: (await response.json()) as T };
}

export function jsonRequest(url: string, method: string, body: unknown, rawBody?: string) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: rawBody ?? JSON.stringify(body),
  });
}

/** POST /api/orders; tracks the created id for cleanup. */
export async function postOrder(body: unknown, rawBody?: string) {
  const response = await toJson<{ order: OrderDto } & { error: { code: string } }>(
    await postOrderHandler(jsonRequest("http://localhost/api/orders", "POST", body, rawBody)),
  );
  if (response.status === 201) trackId(response.body.order.id);
  return response;
}

export async function createTestOrder(label: string): Promise<OrderDto> {
  const response = await postOrder({ title: testTitle(label) });
  if (response.status !== 201) throw new Error(`create failed: HTTP ${response.status}`);
  return response.body.order;
}

/** Test-only shortcut: put a tracked test order directly into a status. */
export async function setStatusDirectly(id: string, status: OrderDto["status"]) {
  if (!trackedIds.has(id)) throw new Error("refusing to modify an untracked record");
  await prisma.order.update({ where: { id }, data: { status } });
}

/** Test-only shortcut: give a tracked test order a vendor (no version change). */
export async function setVendorDirectly(id: string, vendorId = "vendor-metro") {
  if (!trackedIds.has(id)) throw new Error("refusing to modify an untracked record");
  await prisma.order.update({ where: { id }, data: { vendorId } });
}

export async function readRecord(id: string) {
  return prisma.order.findUniqueOrThrow({ where: { id } });
}
