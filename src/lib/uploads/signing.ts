import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { SIMULATED_STORAGE_ORIGIN } from "./constants";

// Pre-signed upload URLs for the SIMULATED object store.
//
// The URL names the object (storage key) and carries the signed terms:
// upload id, order id, exact size, content type, expiry and the allowed
// operation (PUT). The signature is HMAC-SHA256 over those terms with a
// server-side secret (UPLOAD_SIGNING_SECRET); the browser never sees the
// secret, so it cannot change any term or extend the expiry.

export const UPLOAD_OPERATION = "PUT";
const SIGNATURE_VERSION = "SIGNFLOW-UPLOAD-V1";
const MIN_SECRET_LENGTH = 32;

export type SignedUploadTerms = {
  uploadId: string;
  orderId: string;
  storageKey: string;
  sizeBytes: number;
  contentType: string;
  expiresAt: Date;
  operation: string;
};

export function getSigningSecret(): string {
  const secret = process.env.UPLOAD_SIGNING_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `UPLOAD_SIGNING_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters (see .env.example).`,
    );
  }
  return secret;
}

function canonical(terms: SignedUploadTerms): string {
  return [
    SIGNATURE_VERSION,
    terms.operation,
    terms.uploadId,
    terms.orderId,
    terms.storageKey,
    String(terms.sizeBytes),
    terms.contentType,
    String(terms.expiresAt.getTime()),
  ].join("\n");
}

function sign(terms: SignedUploadTerms, secret: string): string {
  return createHmac("sha256", secret).update(canonical(terms)).digest("base64url");
}

export function createSignedUploadUrl(terms: SignedUploadTerms, secret: string): string {
  const url = new URL(`/${terms.storageKey}`, SIMULATED_STORAGE_ORIGIN);
  url.searchParams.set("X-Upload-Id", terms.uploadId);
  url.searchParams.set("X-Order-Id", terms.orderId);
  url.searchParams.set("X-Size", String(terms.sizeBytes));
  url.searchParams.set("X-Content-Type", terms.contentType);
  url.searchParams.set("X-Expires", String(terms.expiresAt.getTime()));
  url.searchParams.set("X-Operation", terms.operation);
  url.searchParams.set("X-Signature", sign(terms, secret));
  return url.toString();
}

export type VerifiedUploadUrl =
  | { ok: true; terms: SignedUploadTerms }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" };

/**
 * Checks that `rawUrl` is a URL this server signed, unchanged. Expiry and
 * whether the terms match a stored upload are checked by the caller.
 */
export function verifySignedUploadUrl(rawUrl: string, secret: string): VerifiedUploadUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (url.origin !== SIMULATED_STORAGE_ORIGIN) return { ok: false, reason: "MALFORMED" };

  const params = url.searchParams;
  const sizeBytes = Number(params.get("X-Size"));
  const expiresMs = Number(params.get("X-Expires"));
  const terms: SignedUploadTerms = {
    uploadId: params.get("X-Upload-Id") ?? "",
    orderId: params.get("X-Order-Id") ?? "",
    storageKey: decodeURIComponent(url.pathname.slice(1)),
    sizeBytes,
    contentType: params.get("X-Content-Type") ?? "",
    expiresAt: new Date(expiresMs),
    operation: params.get("X-Operation") ?? "",
  };
  const signature = params.get("X-Signature") ?? "";
  if (!Number.isSafeInteger(sizeBytes) || !Number.isSafeInteger(expiresMs) || !signature) {
    return { ok: false, reason: "MALFORMED" };
  }

  const expected = Buffer.from(sign(terms, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  return { ok: true, terms };
}
