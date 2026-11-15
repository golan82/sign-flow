import {
  errorResponse,
  internalErrorResponse,
  jsonResponse,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/api/http";
import { changeStatusSchema, orderIdSchema } from "@/lib/orders/schemas";
import { changeOrderStatus } from "@/lib/orders/service";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status";

export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/orders/[id]/status">,
) {
  const { id } = await ctx.params;
  const parsedId = orderIdSchema.safeParse(id);
  if (!parsedId.success) return validationErrorResponse(parsedId.error);

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = changeStatusSchema.safeParse(body.value);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const result = await changeOrderStatus(parsedId.data, parsed.data);
    if (result.ok) return jsonResponse({ order: result.order });

    switch (result.reason) {
      case "NOT_FOUND":
        return errorResponse(404, "NOT_FOUND", "Order not found.");
      case "VERSION_CONFLICT":
        return errorResponse(
          409,
          "VERSION_CONFLICT",
          "The order was changed by another request. Reload it and try again.",
        );
      case "VENDOR_REQUIRED":
        return errorResponse(
          400,
          "VENDOR_REQUIRED",
          "Assign a vendor before marking the order as vendor accepted.",
        );
      case "INVALID_TRANSITION":
        return errorResponse(
          400,
          "INVALID_TRANSITION",
          `Cannot change status from ${ORDER_STATUS_LABELS[result.from]} to ${ORDER_STATUS_LABELS[result.to]}.`,
        );
    }
  } catch (error) {
    return internalErrorResponse("PATCH /api/orders/[id]/status", error);
  }
}
