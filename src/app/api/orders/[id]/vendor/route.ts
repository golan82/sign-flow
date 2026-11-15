import {
  errorResponse,
  internalErrorResponse,
  jsonResponse,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/api/http";
import { assignVendorSchema, orderIdSchema } from "@/lib/orders/schemas";
import { assignVendor } from "@/lib/orders/service";

// Assign, change or remove (vendorId: null) the order's demo vendor.
// Allowed while the order is DRAFT or SUBMITTED; optimistic concurrency via expectedVersion.
export async function PATCH(request: Request, ctx: RouteContext<"/api/orders/[id]/vendor">) {
  const { id } = await ctx.params;
  const parsedId = orderIdSchema.safeParse(id);
  if (!parsedId.success) return validationErrorResponse(parsedId.error);

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = assignVendorSchema.safeParse(body.value);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const result = await assignVendor(parsedId.data, parsed.data);
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
      case "VENDOR_LOCKED":
        return errorResponse(
          400,
          "VENDOR_LOCKED",
          "The vendor can only be changed while the order is a draft or submitted.",
        );
    }
  } catch (error) {
    return internalErrorResponse("PATCH /api/orders/[id]/vendor", error);
  }
}
