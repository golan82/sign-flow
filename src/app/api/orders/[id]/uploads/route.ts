import {
  errorResponse,
  internalErrorResponse,
  jsonResponse,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/api/http";
import { orderIdSchema } from "@/lib/orders/schemas";
import { authorizeUploadSchema } from "@/lib/uploads/schemas";
import { authorizeUpload } from "@/lib/uploads/service";

// Authorize a direct-to-storage upload for an existing order. Returns the
// upload metadata and a signed upload URL for the SIMULATED object store.
// No file bytes are ever sent to this server.
export async function POST(request: Request, ctx: RouteContext<"/api/orders/[id]/uploads">) {
  const { id } = await ctx.params;
  const parsedId = orderIdSchema.safeParse(id);
  if (!parsedId.success) return validationErrorResponse(parsedId.error);

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = authorizeUploadSchema.safeParse(body.value);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const result = await authorizeUpload(parsedId.data, parsed.data);
    if (result.ok) return jsonResponse(result.authorization, result.created ? 201 : 200);
    switch (result.reason) {
      case "ORDER_NOT_FOUND":
        return errorResponse(404, "NOT_FOUND", "Order not found.");
      case "ORDER_NOT_UPLOADABLE":
        return errorResponse(
          400,
          "ORDER_NOT_UPLOADABLE",
          "New uploads cannot be started for a completed or cancelled order.",
        );
      case "IDEMPOTENCY_CONFLICT":
        return errorResponse(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This clientRequestId was already used for a different file.",
        );
      case "DEMO_LIMIT_REACHED":
        return errorResponse(
          409,
          "DEMO_LIMIT_REACHED",
          `This demo allows at most ${result.limit} upload attempts per order (including failed and cancelled ones), and this order has reached it.`,
        );
    }
  } catch (error) {
    return internalErrorResponse("POST /api/orders/[id]/uploads", error);
  }
}
