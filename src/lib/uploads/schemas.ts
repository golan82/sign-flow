// Request payload schemas for the upload API. No server-only imports.
import { z } from "zod";

import {
  ALLOWED_UPLOAD_TYPES,
  getExtension,
  MAX_FILE_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
  UPLOAD_CONTENT_TYPES,
} from "./constants";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const authorizeUploadSchema = z
  .strictObject({
    // One id per "start upload" action; repeating it returns the same attempt.
    clientRequestId: z.uuid(),
    originalName: z
      .string()
      .trim()
      .min(1, "File name is required")
      .max(MAX_FILE_NAME_LENGTH, `File name must be at most ${MAX_FILE_NAME_LENGTH} characters`)
      .refine((name) => !CONTROL_CHARACTERS.test(name), "File name contains control characters")
      .refine((name) => !/[\\/]/.test(name), "File name must not contain path separators"),
    sizeBytes: z
      .number()
      .int()
      .min(1, "File is empty")
      .max(MAX_UPLOAD_BYTES, "File is larger than 5 GB"),
    contentType: z.enum(UPLOAD_CONTENT_TYPES, { error: "Unsupported file type" }),
  })
  .refine(
    (input) =>
      (ALLOWED_UPLOAD_TYPES[input.contentType] as readonly string[]).includes(
        getExtension(input.originalName),
      ),
    { message: "File extension does not match the file type", path: ["originalName"] },
  );

export const uploadIdSchema = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, "Upload id must be a 24-character hex ObjectId");

/** Completion and abort carry the signed URL issued at authorization. */
export const completeUploadSchema = z.strictObject({
  uploadUrl: z.string().max(4096),
});

export const abortUploadSchema = z.strictObject({
  uploadUrl: z.string().max(4096),
  reason: z.enum(["CANCELLED", "FAILED"]),
});

export type AuthorizeUploadInput = z.infer<typeof authorizeUploadSchema>;
export type AbortReason = z.infer<typeof abortUploadSchema>["reason"];
