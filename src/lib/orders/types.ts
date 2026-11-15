import type { ClaimDto } from "@/lib/claims/claims";
import type { UploadDto } from "@/lib/uploads/types";

import type { OrderStatus } from "./status";

// JSON shape of an order returned by the API and the SSE stream.
// Never contains the claim token or its hash, storage keys or signed URLs.
export type OrderDto = {
  id: string;
  title: string;
  description: string | null;
  status: OrderStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  claim: ClaimDto;
  /** Assigned demo vendor id, or null. */
  vendorId: string | null;
  /** Upload metadata, newest first. */
  uploads: UploadDto[];
};

/** Orders plus the database clock, so clients can correct for clock skew. */
export type OrdersSnapshot = {
  orders: OrderDto[];
  serverTime: string;
};

export type ApiErrorCode =
  | "INVALID_JSON"
  | "VALIDATION_ERROR"
  | "INVALID_TRANSITION"
  | "VENDOR_REQUIRED"
  | "VENDOR_LOCKED"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "ORDER_NOT_CLAIMABLE"
  | "CLAIM_UNAVAILABLE"
  | "CLAIM_EXPIRED"
  | "CLAIM_NOT_ACTIVE"
  | "ORDER_NOT_UPLOADABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "DEMO_LIMIT_REACHED"
  | "UPLOAD_SIGNATURE_INVALID"
  | "UPLOAD_EXPIRED"
  | "UPLOAD_CANCELLED"
  | "UPLOAD_FAILED"
  | "UPLOAD_ALREADY_COMPLETED"
  | "INTERNAL_ERROR";

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
    issues?: { path: string; message: string }[];
  };
};
