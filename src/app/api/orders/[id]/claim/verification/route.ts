import {
  errorResponse,
  internalErrorResponse,
  jsonResponse,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/api/http";
import { verificationRequestSchema } from "@/lib/claims/schemas";
import { submitVerification } from "@/lib/claims/service";
import { orderIdSchema } from "@/lib/orders/schemas";

// Simulated identity/payment verification for a pending claim. PASSED
// confirms the claim; FAILED releases it back to the marketplace.
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/orders/[id]/claim/verification">,
) {
  const { id } = await ctx.params;
  const parsedId = orderIdSchema.safeParse(id);
  if (!parsedId.success) return validationErrorResponse(parsedId.error);

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = verificationRequestSchema.safeParse(body.value);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const result = await submitVerification(parsedId.data, parsed.data);
    if (result.ok) return jsonResponse({ order: result.order });
    switch (result.reason) {
      case "NOT_FOUND":
        return errorResponse(404, "NOT_FOUND", "Order not found.");
      case "CLAIM_EXPIRED":
        return errorResponse(
          409,
          "CLAIM_EXPIRED",
          "Your claim expired before verification finished.",
        );
      case "CLAIM_NOT_ACTIVE":
        return errorResponse(
          409,
          "CLAIM_NOT_ACTIVE",
          "This claim is no longer active (it was released, replaced or already confirmed).",
        );
    }
  } catch (error) {
    return internalErrorResponse("POST /api/orders/[id]/claim/verification", error);
  }
}
