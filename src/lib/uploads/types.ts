import type { UploadStatus } from "./constants";

/**
 * Public upload metadata, as listed with orders and sent over SSE. Never
 * contains the storage key, the signed URL or the client request id.
 */
export type UploadDto = {
  id: string;
  originalName: string;
  sizeBytes: number;
  contentType: string;
  status: UploadStatus;
  createdAt: string;
  updatedAt: string;
  /** Signed URL validity; a PENDING_UPLOAD past this instant is expired. */
  expiresAt: string;
  completedAt: string | null;
};

/** Returned only to the browser that requested the authorization. */
export type UploadAuthorization = {
  upload: UploadDto;
  uploadUrl: string;
  expiresAt: string;
};
