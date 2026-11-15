// Browser-side wrappers for the orders API. Every request bypasses the HTTP
// cache so the UI always shows the server's current state.
import type { ClaimRequest, VerificationRequest } from "@/lib/claims/schemas";
import type { AbortReason, AuthorizeUploadInput } from "@/lib/uploads/schemas";
import type { UploadAuthorization, UploadDto } from "@/lib/uploads/types";

import type { AssignVendorInput, ChangeStatusInput, CreateOrderInput } from "./schemas";
import type { ApiErrorBody, ApiErrorCode, OrderDto, OrdersSnapshot } from "./types";

export type ClientError = {
  code: ApiErrorCode | "NETWORK_ERROR" | "UNEXPECTED_RESPONSE";
  message: string;
  issues?: ApiErrorBody["error"]["issues"];
};

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ClientError };

async function request<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: "NETWORK_ERROR", message: "Could not reach the server. Check your connection." },
    };
  }

  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    return { ok: true, status: response.status, data: body as T };
  }
  const error = (body as Partial<ApiErrorBody> | null)?.error;
  return {
    ok: false,
    status: response.status,
    error: error ?? {
      code: "UNEXPECTED_RESPONSE",
      message: `Unexpected response from the server (HTTP ${response.status}).`,
    },
  };
}

export function fetchOrders() {
  return request<OrdersSnapshot>("/api/orders");
}

export function claimRequest(id: string, input: ClaimRequest) {
  return request<{ order: OrderDto; claimToken: string }>(
    `/api/orders/${encodeURIComponent(id)}/claim`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function assignVendorRequest(id: string, input: AssignVendorInput) {
  return request<{ order: OrderDto }>(`/api/orders/${encodeURIComponent(id)}/vendor`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function authorizeUploadRequest(orderId: string, input: AuthorizeUploadInput) {
  return request<UploadAuthorization>(`/api/orders/${encodeURIComponent(orderId)}/uploads`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function uploadPath(orderId: string, uploadId: string, action: "complete" | "abort") {
  return `/api/orders/${encodeURIComponent(orderId)}/uploads/${encodeURIComponent(uploadId)}/${action}`;
}

export function completeUploadRequest(orderId: string, uploadId: string, uploadUrl: string) {
  return request<{ upload: UploadDto; changed: boolean }>(uploadPath(orderId, uploadId, "complete"), {
    method: "POST",
    body: JSON.stringify({ uploadUrl }),
  });
}

export function abortUploadRequest(orderId: string, uploadId: string, uploadUrl: string, reason: AbortReason) {
  return request<{ upload: UploadDto; changed: boolean }>(uploadPath(orderId, uploadId, "abort"), {
    method: "POST",
    body: JSON.stringify({ uploadUrl, reason }),
  });
}

export function verificationRequest(id: string, input: VerificationRequest) {
  return request<{ order: OrderDto }>(
    `/api/orders/${encodeURIComponent(id)}/claim/verification`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function createOrderRequest(input: CreateOrderInput) {
  return request<{ order: OrderDto }>("/api/orders", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function changeStatusRequest(id: string, input: ChangeStatusInput) {
  return request<{ order: OrderDto }>(`/api/orders/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
