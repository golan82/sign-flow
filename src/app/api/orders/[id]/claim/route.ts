import {
  errorResponse,
  internalErrorResponse,
  jsonResponse,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/api/http";
import { claimRequestSchema } from "@/lib/claims/schemas";
import { claimOrder } from "@/lib/claims/service";
import { orderIdSchema } from "@/lib/orders/schemas";

// Claim a READY_FOR_INSTALL order as a demo installer. The response is the
// only place the claim token is ever returned.
export async function POST(request: Request, ctx: RouteContext<"/api/orders/[id]/claim">) {
  const { id } = await ctx.params;
  const parsedId = orderIdSchema.safeParse(id);
  if (!parsedId.success) return validationErrorResponse(parsedId.error);

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = claimRequestSchema.safeParse(body.value);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const result = await claimOrder(parsedId.data, parsed.data.installerId);
    if (result.ok) {
      return jsonResponse({ order: result.order, claimToken: result.claimToken }, 201);
    }
    switch (result.reason) {
      case "NOT_FOUND":
        return errorResponse(404, "NOT_FOUND", "Order not found.");
      case "NOT_CLAIMABLE":
        return errorResponse(
          400,
          "ORDER_NOT_CLAIMABLE",
          "Only orders that are ready for install can be claimed.",
        );
      case "ALREADY_CLAIMED":
        return errorResponse(409, "CLAIM_UNAVAILABLE", "Another installer has already claimed this job.");
    }
  } catch (error) {
    return internalErrorResponse("POST /api/orders/[id]/claim", error);
  }
}
