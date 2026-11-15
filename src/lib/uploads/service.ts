import "server-only";

import { randomBytes } from "node:crypto";

import { Prisma, type $Enums, type Upload } from "@prisma/client";
import { ObjectId } from "mongodb";

import { getDatabaseTime } from "@/lib/claims/store.mts";
import { MAX_UPLOAD_ATTEMPTS_PER_ORDER } from "@/lib/demo-limits.mts";
import { isTerminalStatus } from "@/lib/orders/status";
import { prisma } from "@/lib/prisma";

import { getExtension, UPLOAD_AUTHORIZATION_TTL_MS, type UploadStatus } from "./constants";
import type { AbortReason, AuthorizeUploadInput } from "./schemas";
import {
  createSignedUploadUrl,
  getSigningSecret,
  UPLOAD_OPERATION,
  verifySignedUploadUrl,
  type SignedUploadTerms,
} from "./signing";
import type { UploadAuthorization, UploadDto } from "./types";

// Fails to compile if the shared statuses and the Prisma enum drift apart.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const statusesMatchPrismaEnum: Equals<UploadStatus, $Enums.UploadStatus> = true;
void statusesMatchPrismaEnum;

// MongoDB collections backing the Upload and Order models (@@map in prisma/schema.prisma).
const UPLOADS_COLLECTION = "uploads";
const ORDERS_COLLECTION = "orders";

// `now` lets tests use a fixed clock; production uses MongoDB's clock.
type ClockOptions = { now?: Date };
const nowExpr = (now?: Date) => (now ? { $date: now.toISOString() } : "$$NOW");

export function toUploadDto(upload: Upload): UploadDto {
  return {
    id: upload.id,
    originalName: upload.originalName,
    sizeBytes: Number(upload.sizeBytes),
    contentType: upload.contentType,
    status: upload.status,
    createdAt: upload.createdAt.toISOString(),
    updatedAt: upload.updatedAt.toISOString(),
    expiresAt: upload.authorizationExpiresAt.toISOString(),
    completedAt: upload.completedAt?.toISOString() ?? null,
  };
}

/** Upload metadata for the given orders, newest first per order. */
export async function listUploadsByOrder(orderIds: string[]): Promise<Map<string, UploadDto[]>> {
  const byOrder = new Map<string, UploadDto[]>();
  if (orderIds.length === 0) return byOrder;
  const uploads = await prisma.upload.findMany({
    where: { orderId: { in: orderIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  for (const upload of uploads) {
    const list = byOrder.get(upload.orderId) ?? [];
    list.push(toUploadDto(upload));
    byOrder.set(upload.orderId, list);
  }
  return byOrder;
}

function termsOf(upload: Upload): SignedUploadTerms {
  return {
    uploadId: upload.id,
    orderId: upload.orderId,
    storageKey: upload.storageKey,
    sizeBytes: Number(upload.sizeBytes),
    contentType: upload.contentType,
    expiresAt: upload.authorizationExpiresAt,
    operation: UPLOAD_OPERATION,
  };
}

function authorizationFor(upload: Upload, secret: string): UploadAuthorization {
  return {
    upload: toUploadDto(upload),
    uploadUrl: createSignedUploadUrl(termsOf(upload), secret),
    expiresAt: upload.authorizationExpiresAt.toISOString(),
  };
}

export type AuthorizeResult =
  | { ok: true; created: boolean; authorization: UploadAuthorization }
  | { ok: false; reason: "ORDER_NOT_FOUND" | "ORDER_NOT_UPLOADABLE" | "IDEMPOTENCY_CONFLICT" }
  | { ok: false; reason: "DEMO_LIMIT_REACHED"; limit: number };

/**
 * The same clientRequestId for the same file returns the existing attempt;
 * for a different file it is a conflict.
 */
async function existingAttempt(
  orderId: string,
  input: AuthorizeUploadInput,
  secret: string,
): Promise<AuthorizeResult | null> {
  const existing = await prisma.upload.findUnique({
    where: { orderId_clientRequestId: { orderId, clientRequestId: input.clientRequestId } },
  });
  if (!existing) return null;
  if (
    existing.originalName === input.originalName &&
    Number(existing.sizeBytes) === input.sizeBytes &&
    existing.contentType === input.contentType
  ) {
    return { ok: true, created: false, authorization: authorizationFor(existing, secret) };
  }
  return { ok: false, reason: "IDEMPOTENCY_CONFLICT" };
}

const RESERVED_REQUEST_IDS = { $ifNull: ["$uploadRequestIds", []] };

/**
 * Reserves a place for this clientRequestId among the order's upload attempts
 * with ONE conditional write: it matches if the id already holds a place, or
 * if fewer than `limit` ids do, and adds the id to the set. So concurrent
 * requests never exceed the limit, and repeats of one request (a double click,
 * a retry after an error) share a single place. Places are never given back:
 * every attempt counts, whatever its outcome.
 */
async function reserveUploadAttempt(orderId: string, clientRequestId: string, limit: number): Promise<boolean> {
  const requestId = { $literal: clientRequestId };
  const result = await prisma.$runCommandRaw({
    update: ORDERS_COLLECTION,
    updates: [
      {
        q: {
          _id: { $oid: orderId },
          $expr: {
            $or: [{ $in: [requestId, RESERVED_REQUEST_IDS] }, { $lt: [{ $size: RESERVED_REQUEST_IDS }, limit] }],
          },
        },
        u: [{ $set: { uploadRequestIds: { $setUnion: [RESERVED_REQUEST_IDS, [requestId]] } } }],
      },
    ],
  } as Prisma.InputJsonObject);
  if (result.ok !== 1 || result.writeErrors) {
    throw new Error(`Upload attempt reservation failed: ${JSON.stringify(result)}`);
  }
  return result.n === 1;
}

/**
 * Creates an upload attempt for an existing order and returns a signed upload
 * URL. Repeating the request with the same clientRequestId returns the same
 * attempt instead of creating a duplicate, and does not count against the
 * per-order limit (MAX_UPLOAD_ATTEMPTS_PER_ORDER); every new attempt does,
 * whatever its outcome.
 */
export async function authorizeUpload(
  orderId: string,
  input: AuthorizeUploadInput,
  { now, maxAttempts = MAX_UPLOAD_ATTEMPTS_PER_ORDER }: ClockOptions & { maxAttempts?: number } = {},
): Promise<AuthorizeResult> {
  const secret = getSigningSecret();
  // The order status is checked when the authorization is requested. Uploads
  // live in another collection (no multi-document transaction), so an attempt
  // authorized before the order became final may still complete or be
  // aborted afterwards; only NEW attempts are refused for final orders.
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };
  if (isTerminalStatus(order.status)) return { ok: false, reason: "ORDER_NOT_UPLOADABLE" };

  // A repeated request for a stored attempt is answered without any write.
  const repeated = await existingAttempt(orderId, input, secret);
  if (repeated) return repeated;
  if (!(await reserveUploadAttempt(orderId, input.clientRequestId, maxAttempts))) {
    return { ok: false, reason: "DEMO_LIMIT_REACHED", limit: maxAttempts };
  }

  const issuedAt = now ?? (await getDatabaseTime(prisma));
  const uploadId = new ObjectId().toHexString();
  // Server-generated key; only the validated extension comes from the client.
  const storageKey = `orders/${orderId}/${uploadId}/${randomBytes(12).toString("hex")}.${getExtension(input.originalName)}`;

  try {
    const upload = await prisma.upload.create({
      data: {
        id: uploadId,
        orderId,
        originalName: input.originalName,
        sizeBytes: BigInt(input.sizeBytes),
        contentType: input.contentType,
        storageKey,
        clientRequestId: input.clientRequestId,
        authorizationExpiresAt: new Date(issuedAt.getTime() + UPLOAD_AUTHORIZATION_TTL_MS),
      },
    });
    return { ok: true, created: true, authorization: authorizationFor(upload, secret) };
  } catch (error) {
    // Any other failure keeps the place: a retry with the same clientRequestId reuses it.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    // The same request raced with itself: answer with the attempt that won.
    return (await existingAttempt(orderId, input, secret)) ?? { ok: false, reason: "IDEMPOTENCY_CONFLICT" };
  }
}

export type SignedActionFailure =
  | "NOT_FOUND"
  | "SIGNATURE_INVALID"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED"
  | "ALREADY_COMPLETED";

export type SignedActionResult =
  | { ok: true; changed: boolean; upload: UploadDto }
  | { ok: false; reason: SignedActionFailure };

/**
 * Accepts the request only with an unmodified URL signed for exactly this
 * order, this upload and its stored terms. Swapping ids or editing any term
 * fails here.
 */
async function loadSignedUpload(
  orderId: string,
  uploadId: string,
  uploadUrl: string,
): Promise<{ ok: true; upload: Upload } | { ok: false; reason: SignedActionFailure }> {
  const verified = verifySignedUploadUrl(uploadUrl, getSigningSecret());
  if (!verified.ok) return { ok: false, reason: "SIGNATURE_INVALID" };
  const { terms } = verified;
  if (terms.uploadId !== uploadId || terms.orderId !== orderId || terms.operation !== UPLOAD_OPERATION) {
    return { ok: false, reason: "SIGNATURE_INVALID" };
  }

  const upload = await prisma.upload.findFirst({ where: { id: uploadId, orderId } });
  if (!upload) return { ok: false, reason: "NOT_FOUND" };
  const stored = termsOf(upload);
  if (
    stored.storageKey !== terms.storageKey ||
    stored.sizeBytes !== terms.sizeBytes ||
    stored.contentType !== terms.contentType ||
    stored.expiresAt.getTime() !== terms.expiresAt.getTime()
  ) {
    return { ok: false, reason: "SIGNATURE_INVALID" };
  }
  return { ok: true, upload };
}

const TERMINAL_FAILURE: Partial<Record<UploadStatus, SignedActionFailure>> = {
  COMPLETED: "ALREADY_COMPLETED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
};

/**
 * Moves a PENDING_UPLOAD attempt to `target` with one conditional write that
 * also requires the authorization to be unexpired at write time. Replaying
 * the same outcome is idempotent (returns ok, changed: false).
 */
async function finishUpload(
  orderId: string,
  uploadId: string,
  uploadUrl: string,
  target: "COMPLETED" | AbortReason,
  now: Date | undefined,
): Promise<SignedActionResult> {
  const loaded = await loadSignedUpload(orderId, uploadId, uploadUrl);
  if (!loaded.ok) return loaded;
  if (loaded.upload.status === target) {
    return { ok: true, changed: false, upload: toUploadDto(loaded.upload) };
  }
  const blocked = TERMINAL_FAILURE[loaded.upload.status];
  if (blocked) return { ok: false, reason: blocked };

  const at = nowExpr(now);
  const result = await prisma.$runCommandRaw({
    update: UPLOADS_COLLECTION,
    updates: [
      {
        q: {
          _id: { $oid: uploadId },
          orderId: { $oid: orderId },
          status: "PENDING_UPLOAD",
          $expr: { $gt: ["$authorizationExpiresAt", at] },
        },
        u: [
          {
            $set: {
              status: target,
              updatedAt: at,
              ...(target === "COMPLETED" ? { completedAt: at } : {}),
            },
          },
        ],
      },
    ],
  } as Prisma.InputJsonObject);
  if (result.ok !== 1 || result.writeErrors) {
    throw new Error(`Upload update failed: ${JSON.stringify(result)}`);
  }

  const current = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
  if (result.n === 1) return { ok: true, changed: true, upload: toUploadDto(current) };
  // Lost a race or the authorization expired; explain from the current state.
  if (current.status === target) return { ok: true, changed: false, upload: toUploadDto(current) };
  return { ok: false, reason: TERMINAL_FAILURE[current.status] ?? "EXPIRED" };
}

/**
 * The browser reports that its (simulated) direct upload finished.
 * In this simulation the report is not proof that the object exists; with a
 * real object store the server would confirm it there first (see README).
 */
export function completeUpload(
  orderId: string,
  uploadId: string,
  uploadUrl: string,
  { now }: ClockOptions = {},
): Promise<SignedActionResult> {
  return finishUpload(orderId, uploadId, uploadUrl, "COMPLETED", now);
}

/** The browser cancelled the upload or it failed; ends that attempt only. */
export function abortUpload(
  orderId: string,
  uploadId: string,
  uploadUrl: string,
  reason: AbortReason,
  { now }: ClockOptions = {},
): Promise<SignedActionResult> {
  return finishUpload(orderId, uploadId, uploadUrl, reason, now);
}
