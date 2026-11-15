import "server-only";

import { errorResponse, jsonResponse } from "@/lib/api/http";

import type { SignedActionResult } from "./service";

/** HTTP mapping shared by the complete and abort routes. */
export function signedActionResponse(result: SignedActionResult): Response {
  if (result.ok) return jsonResponse({ upload: result.upload, changed: result.changed });
  switch (result.reason) {
    case "NOT_FOUND":
      return errorResponse(404, "NOT_FOUND", "Upload not found.");
    case "SIGNATURE_INVALID":
      return errorResponse(
        403,
        "UPLOAD_SIGNATURE_INVALID",
        "The upload URL is not a valid, unmodified authorization for this upload.",
      );
    case "EXPIRED":
      return errorResponse(409, "UPLOAD_EXPIRED", "The upload authorization has expired. Start a new upload.");
    case "CANCELLED":
      return errorResponse(409, "UPLOAD_CANCELLED", "This upload was cancelled.");
    case "FAILED":
      return errorResponse(409, "UPLOAD_FAILED", "This upload was marked as failed.");
    case "ALREADY_COMPLETED":
      return errorResponse(409, "UPLOAD_ALREADY_COMPLETED", "This upload has already completed.");
  }
}
