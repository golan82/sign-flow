// Request payload schemas for the orders API. Also used by the UI for
// client-side validation, so no server-only imports here.
import { z } from "zod";

import { DEMO_VENDOR_IDS } from "@/lib/vendors/vendors";

import { ORDER_STATUSES } from "./status";

export const TITLE_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 2000;

export const orderIdSchema = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, "Order id must be a 24-character hex ObjectId");

export const createOrderSchema = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(TITLE_MAX_LENGTH, `Title must be at most ${TITLE_MAX_LENGTH} characters`),
  // Blank descriptions are stored as "no description".
  description: z
    .string()
    .trim()
    .max(
      DESCRIPTION_MAX_LENGTH,
      `Description must be at most ${DESCRIPTION_MAX_LENGTH} characters`,
    )
    .optional()
    .transform((value) => (value ? value : undefined)),
});

export const changeStatusSchema = z.strictObject({
  targetStatus: z.enum(ORDER_STATUSES),
  expectedVersion: z.number().int().nonnegative(),
});

export const assignVendorSchema = z.strictObject({
  // null removes the vendor.
  vendorId: z.enum(DEMO_VENDOR_IDS, { error: "vendorId must be one of the demo vendors" }).nullable(),
  expectedVersion: z.number().int().nonnegative(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
export type AssignVendorInput = z.infer<typeof assignVendorSchema>;
