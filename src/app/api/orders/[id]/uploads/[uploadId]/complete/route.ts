import { internalErrorResponse, readJsonBody, validationErrorResponse } from "@/lib/api/http";
import { orderIdSchema } from "@/lib/orders/schemas";
import { signedActionResponse } from "@/lib/uploads/responses";
import { completeUploadSchema, uploadIdSchema } from "@/lib/uploads/schemas";
import { completeUpload } from "@/lib/uploads/service";

// The browser reports that its direct (simulated) upload finished. Requires
// the signed upload URL issued for exactly this upload. Idempotent.
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/orders/[id]/uploads/[uploadId]/complete">,
) {
  const { id, uploadId } = await ctx.params;
  const orderId = orderIdSchema.safeParse(id);
  if (!orderId.success) return validationErrorResponse(orderId.error);
  const parsedUploadId = uploadIdSchema.safeParse(uploadId);
  if (!parsedUploadId.success) return validationErrorResponse(parsedUploadId.error);

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = completeUploadSchema.safeParse(body.value);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    return signedActionResponse(
      await completeUpload(orderId.data, parsedUploadId.data, parsed.data.uploadUrl),
    );
  } catch (error) {
    return internalErrorResponse("POST /api/orders/[id]/uploads/[uploadId]/complete", error);
  }
}
