import type { UploadDto } from "@/lib/uploads/types";

import type { OrderDto } from "./types";

/**
 * Upload lists from two reads of the same order. Uploads are never deleted
 * and only move PENDING_UPLOAD -> one final status, so: keep every upload
 * either side knows, and never move one back from a final status to pending.
 * (Upload changes do not bump order.version, so the version alone cannot
 * order them.)
 */
function mergeUploads(existing: UploadDto[], incoming: UploadDto[]): UploadDto[] {
  const byId = new Map(incoming.map((upload) => [upload.id, upload]));
  for (const upload of existing) {
    const other = byId.get(upload.id);
    if (!other || (other.status === "PENDING_UPLOAD" && upload.status !== "PENDING_UPLOAD")) {
      byId.set(upload.id, upload);
    }
  }
  return [...byId.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}

/** The fresher of two reads of one order: higher version wins, uploads are merged. */
function mergeOrder(existing: OrderDto, incoming: OrderDto): OrderDto {
  const base = existing.version > incoming.version ? existing : incoming;
  return { ...base, uploads: mergeUploads(existing.uploads, incoming.uploads) };
}

/**
 * Applies a full server snapshot (SSE or GET) to the list the UI already
 * shows. The snapshot decides which orders exist and their order, but data
 * never moves backwards: an order the UI already has at a higher version is
 * kept, and upload statuses never regress, whichever response arrives last.
 */
export function mergeOrderSnapshot(current: OrderDto[] | null, incoming: OrderDto[]): OrderDto[] {
  if (!current) return incoming;
  const known = new Map(current.map((order) => [order.id, order]));
  return incoming.map((order) => {
    const existing = known.get(order.id);
    return existing ? mergeOrder(existing, order) : order;
  });
}

/** Puts a single server-returned order into the list, merged with what is shown. */
export function upsertOrder(current: OrderDto[] | null, order: OrderDto): OrderDto[] {
  if (!current) return [order];
  const index = current.findIndex((existing) => existing.id === order.id);
  if (index === -1) return [order, ...current];
  return current.map((existing, i) => (i === index ? mergeOrder(existing, order) : existing));
}
