import "server-only";

import { Prisma, type $Enums, type Order } from "@prisma/client";

import { getDatabaseTime } from "@/lib/claims/store.mts";
import { MAX_DEMO_ORDERS } from "@/lib/demo-limits.mts";
import { prisma } from "@/lib/prisma";
import { listUploadsByOrder } from "@/lib/uploads/service";
import type { UploadDto } from "@/lib/uploads/types";
import {
  canChangeVendor,
  VENDOR_EDITABLE_STATUSES,
  VENDOR_REQUIRED_FOR,
} from "@/lib/vendors/vendors";

import type { AssignVendorInput, ChangeStatusInput, CreateOrderInput } from "./schemas";
import { canTransition, type OrderStatus } from "./status";
import type { OrderDto, OrdersSnapshot } from "./types";

// Fails to compile if the shared status list and the Prisma enum drift apart.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const statusesMatchPrismaEnum: Equals<OrderStatus, $Enums.OrderStatus> = true;
void statusesMatchPrismaEnum;

// MongoDB collection backing the Order model (@@map in prisma/schema.prisma).
const ORDERS_COLLECTION = "orders";

// The claim token hash is deliberately not part of the input type.
export function toOrderDto(order: Omit<Order, "claimTokenHash">, uploads: UploadDto[] = []): OrderDto {
  return {
    id: order.id,
    title: order.title,
    description: order.description,
    status: order.status,
    version: order.version,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    claim: {
      // Documents written before claims existed have no claim fields.
      state: order.claimState ?? "NONE",
      installerId: order.claimInstallerId ?? null,
      expiresAt: order.claimExpiresAt?.toISOString() ?? null,
      claimedAt: order.claimedAt?.toISOString() ?? null,
      confirmedAt: order.claimConfirmedAt?.toISOString() ?? null,
    },
    vendorId: order.vendorId ?? null,
    uploads,
  };
}

/** DTO for one order including its upload metadata (for mutation responses). */
export async function toOrderDtoWithUploads(order: Omit<Order, "claimTokenHash">): Promise<OrderDto> {
  const uploads = await listUploadsByOrder([order.id]);
  return toOrderDto(order, uploads.get(order.id) ?? []);
}

export async function listOrders(): Promise<OrderDto[]> {
  const orders = await prisma.order.findMany({
    // _id breaks ties between orders created in the same millisecond.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    omit: { claimTokenHash: true },
  });
  const uploads = await listUploadsByOrder(orders.map((order) => order.id));
  return orders.map((order) => toOrderDto(order, uploads.get(order.id) ?? []));
}

/** All orders plus MongoDB's clock (the clock claim expiry is measured on). */
export async function getOrdersSnapshot(): Promise<OrdersSnapshot> {
  const [orders, serverTime] = await Promise.all([listOrders(), getDatabaseTime(prisma)]);
  return { orders, serverTime: serverTime.toISOString() };
}

export type CreateOrderResult =
  | { ok: true; order: OrderDto }
  | { ok: false; reason: "DEMO_LIMIT_REACHED"; limit: number };

const ORDER_LIMIT_LOCK_ID = "orders";
const MAX_CREATE_ATTEMPTS = 50;

/** Write conflict (P2034) or a lost race creating the lock document (P2002). */
function isRetryableTransactionError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" || error.code === "P2002")
  );
}

/**
 * Creates an order unless the database already holds `maxOrders` orders
 * (MAX_DEMO_ORDERS). Count and insert run in one transaction that also writes
 * the shared DemoLimit document: concurrent creations write the same document,
 * so MongoDB aborts all but one with a write conflict and they retry with a
 * fresh count. The count is of the real orders, so deletions made outside the
 * app (test cleanup, a manual reset) free their places.
 */
export async function createOrder(
  input: CreateOrderInput,
  { maxOrders = MAX_DEMO_ORDERS }: { maxOrders?: number } = {},
): Promise<CreateOrderResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.demoLimit.upsert({
          where: { id: ORDER_LIMIT_LOCK_ID },
          create: { id: ORDER_LIMIT_LOCK_ID, seq: 1 },
          update: { seq: { increment: 1 } },
        });
        if ((await tx.order.count()) >= maxOrders) {
          return { ok: false, reason: "DEMO_LIMIT_REACHED", limit: maxOrders } as const;
        }
        const order = await tx.order.create({
          data: { title: input.title, description: input.description ?? null },
        });
        return { ok: true, order: toOrderDto(order) } as const;
      });
    } catch (error) {
      if (attempt >= MAX_CREATE_ATTEMPTS || !isRetryableTransactionError(error)) throw error;
      // Short random pause so the conflicting creations do not retry in lockstep.
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
    }
  }
}

/**
 * One conditional single-document update of an order (filter + update
 * pipeline); returns whether it matched. prisma.order.updateMany is not used:
 * for MongoDB, Prisma 6 runs an aggregate to select matching ids and then an
 * update filtered by _id alone (inside a transaction), so the conditions would
 * not be part of the write itself.
 */
async function conditionalOrderUpdate(
  filter: Record<string, unknown>,
  set: Record<string, unknown>,
): Promise<boolean> {
  const result = await prisma.$runCommandRaw({
    update: ORDERS_COLLECTION,
    updates: [{ q: filter, u: [{ $set: set }] }],
  } as Prisma.InputJsonObject);
  if (result.ok !== 1 || result.writeErrors) {
    throw new Error(`Order update failed: ${JSON.stringify(result)}`);
  }
  return result.n === 1;
}

const VERSION_PLUS_ONE = { $add: [{ $ifNull: ["$version", 0] }, 1] };

// When an order is completed, a still-pending installer claim can never be
// confirmed (confirmation requires READY_FOR_INSTALL), so it is released in
// the same write. A confirmed claim is kept as the record of who installed.
const IS_PENDING_CLAIM = { $eq: ["$claimState", "PENDING_VERIFICATION"] };
const RELEASE_PENDING_CLAIM = {
  claimState: { $cond: [IS_PENDING_CLAIM, "NONE", "$claimState"] },
  ...Object.fromEntries(
    ["claimInstallerId", "claimTokenHash", "claimExpiresAt", "claimedAt", "claimConfirmedAt"].map((field) => [
      field,
      { $cond: [IS_PENDING_CLAIM, null, `$${field}`] },
    ]),
  ),
};

export type ChangeStatusResult =
  | { ok: true; order: OrderDto }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "VERSION_CONFLICT" }
  | { ok: false; reason: "VENDOR_REQUIRED" }
  | { ok: false; reason: "INVALID_TRANSITION"; from: OrderStatus; to: OrderStatus };

export async function changeOrderStatus(
  id: string,
  { targetStatus, expectedVersion }: ChangeStatusInput,
): Promise<ChangeStatusResult> {
  const current = await prisma.order.findUnique({ where: { id } });
  if (!current) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  if (current.version !== expectedVersion) {
    return { ok: false, reason: "VERSION_CONFLICT" };
  }
  if (!canTransition(current.status, targetStatus)) {
    return { ok: false, reason: "INVALID_TRANSITION", from: current.status, to: targetStatus };
  }
  if (targetStatus === VENDOR_REQUIRED_FOR && !current.vendorId) {
    return { ok: false, reason: "VENDOR_REQUIRED" };
  }

  // One conditional write: it matches only while the order still has the
  // status and version validated above (so also the same vendor and claim),
  // and bumps the version atomically.
  const matched = await conditionalOrderUpdate(
    { _id: { $oid: id }, status: current.status, version: expectedVersion },
    {
      status: targetStatus,
      version: VERSION_PLUS_ONE,
      updatedAt: "$$NOW",
      ...(targetStatus === "COMPLETED" ? RELEASE_PENDING_CLAIM : {}),
    },
  );
  if (!matched) {
    // Another request changed the order between our read and write.
    return { ok: false, reason: "VERSION_CONFLICT" };
  }

  const updated = await prisma.order.findUnique({ where: { id } });
  if (!updated) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  return { ok: true, order: await toOrderDtoWithUploads(updated) };
}

export type AssignVendorResult =
  | { ok: true; order: OrderDto }
  | { ok: false; reason: "NOT_FOUND" | "VERSION_CONFLICT" | "VENDOR_LOCKED" };

/**
 * Assigns, changes or removes (null) the demo vendor while the order is DRAFT
 * or SUBMITTED. Same optimistic concurrency as status changes.
 */
export async function assignVendor(
  id: string,
  { vendorId, expectedVersion }: AssignVendorInput,
): Promise<AssignVendorResult> {
  const current = await prisma.order.findUnique({ where: { id } });
  if (!current) return { ok: false, reason: "NOT_FOUND" };
  if (current.version !== expectedVersion) return { ok: false, reason: "VERSION_CONFLICT" };
  if (!canChangeVendor(current.status)) return { ok: false, reason: "VENDOR_LOCKED" };

  const matched = await conditionalOrderUpdate(
    {
      _id: { $oid: id },
      version: expectedVersion,
      status: { $in: [...VENDOR_EDITABLE_STATUSES] },
    },
    { vendorId: { $literal: vendorId }, version: VERSION_PLUS_ONE, updatedAt: "$$NOW" },
  );
  if (!matched) return { ok: false, reason: "VERSION_CONFLICT" };

  const updated = await prisma.order.findUnique({ where: { id } });
  if (!updated) return { ok: false, reason: "NOT_FOUND" };
  return { ok: true, order: await toOrderDtoWithUploads(updated) };
}
