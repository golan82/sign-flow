import { connection } from "next/server";

import {
  errorResponse,
  internalErrorResponse,
  jsonResponse,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/api/http";
import { createOrderSchema } from "@/lib/orders/schemas";
import { createOrder, getOrdersSnapshot } from "@/lib/orders/service";

export async function GET() {
  // Always run at request time: never prerender or reuse the order list.
  await connection();
  try {
    // { orders, serverTime }: serverTime is the database clock for countdowns.
    return jsonResponse(await getOrdersSnapshot());
  } catch (error) {
    return internalErrorResponse("GET /api/orders", error);
  }
}

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = createOrderSchema.safeParse(body.value);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const result = await createOrder(parsed.data);
    if (result.ok) return jsonResponse({ order: result.order }, 201);
    return errorResponse(
      409,
      "DEMO_LIMIT_REACHED",
      `This demo holds at most ${result.limit} orders, and that limit has been reached. No order was created.`,
    );
  } catch (error) {
    return internalErrorResponse("POST /api/orders", error);
  }
}
