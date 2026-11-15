import { internalErrorResponse, readJsonBody, validationErrorResponse } from "@/lib/api/http";
import { orderIdSchema } from "@/lib/orders/schemas";
import { signedActionResponse } from "@/lib/uploads/responses";
import { abortUploadSchema, uploadIdSchema } from "@/lib/uploads/schemas";
import { abortUpload } from "@/lib/uploads/service";

// The browser cancelled its upload or the upload failed. Ends only the
// attempt named by the signed URL. Idempotent for the same reason.
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/orders/[id]/uploads/[uploadId]/abort">,
) {
  const { id, uploadId } = await ctx.params;
  const orderId = orderIdSchema.safeParse(id);
  if (!orderId.success) return validationErrorResponse(orderId.error);
  const parsedUploadId = uploadIdSchema.safeParse(uploadId);
  if (!parsedUploadId.success) return validationErrorResponse(parsedUploadId.error);

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = abortUploadSchema.safeParse(body.value);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    return signedActionResponse(
      await abortUpload(orderId.data, parsedUploadId.data, parsed.data.uploadUrl, parsed.data.reason),
    );
  } catch (error) {
    return internalErrorResponse("POST /api/orders/[id]/uploads/[uploadId]/abort", error);
  }
}
