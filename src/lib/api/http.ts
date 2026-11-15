import type { z } from "zod";

import type { ApiErrorBody, ApiErrorCode } from "@/lib/orders/types";

// API responses reflect live data and must never be served from a cache.
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

export function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  issues?: ApiErrorBody["error"]["issues"],
): Response {
  const body: ApiErrorBody = { error: { code, message, ...(issues && { issues }) } };
  return jsonResponse(body, status);
}

export function validationErrorResponse(error: z.ZodError): Response {
  return errorResponse(
    400,
    "VALIDATION_ERROR",
    "Request validation failed.",
    error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );
}

export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return {
      ok: false,
      response: errorResponse(400, "INVALID_JSON", "Request body must be valid JSON."),
    };
  }
}

// Logs the real error server-side; the client only gets a generic message.
export function internalErrorResponse(context: string, error: unknown): Response {
  console.error(`[api] ${context} failed`, error);
  return errorResponse(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
}
