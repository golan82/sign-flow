import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSignedUploadUrl,
  getSigningSecret,
  verifySignedUploadUrl,
  type SignedUploadTerms,
} from "./signing";

const SECRET = "test-secret-0123456789-0123456789-abcdef";
const terms: SignedUploadTerms = {
  uploadId: "6650f1c2a1b2c3d4e5f60001",
  orderId: "6650f1c2a1b2c3d4e5f60002",
  storageKey: "orders/6650f1c2a1b2c3d4e5f60002/6650f1c2a1b2c3d4e5f60001/abc.pdf",
  sizeBytes: 1_610_612_736,
  contentType: "application/pdf",
  expiresAt: new Date("2031-01-01T00:30:00.000Z"),
  operation: "PUT",
};

afterEach(() => vi.unstubAllEnvs());

describe("signed upload URLs", () => {
  it("round-trips the signed terms", () => {
    const url = createSignedUploadUrl(terms, SECRET);
    expect(url.startsWith("https://simulated-storage.invalid/orders/")).toBe(true);
    expect(verifySignedUploadUrl(url, SECRET)).toEqual({ ok: true, terms });
  });

  it.each([
    ["X-Upload-Id", "6650f1c2a1b2c3d4e5f69999"],
    ["X-Order-Id", "6650f1c2a1b2c3d4e5f69999"],
    ["X-Size", "1"],
    ["X-Content-Type", "image/png"],
    ["X-Expires", String(new Date("2099-01-01").getTime())],
    ["X-Operation", "DELETE"],
  ])("rejects a URL whose %s was changed", (param, value) => {
    const url = new URL(createSignedUploadUrl(terms, SECRET));
    url.searchParams.set(param, value);
    expect(verifySignedUploadUrl(url.toString(), SECRET)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects a changed storage key, a wrong secret and a foreign origin", () => {
    const url = new URL(createSignedUploadUrl(terms, SECRET));
    const moved = new URL(url);
    moved.pathname = "/orders/other/key.pdf";
    expect(verifySignedUploadUrl(moved.toString(), SECRET).ok).toBe(false);
    expect(verifySignedUploadUrl(url.toString(), `${SECRET}-other`).ok).toBe(false);
    const foreign = new URL(url);
    foreign.host = "s3.amazonaws.com";
    expect(verifySignedUploadUrl(foreign.toString(), SECRET)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(verifySignedUploadUrl("not a url", SECRET)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("requires a configured secret of at least 32 characters", () => {
    vi.stubEnv("UPLOAD_SIGNING_SECRET", "");
    expect(() => getSigningSecret()).toThrow(/UPLOAD_SIGNING_SECRET/);
    vi.stubEnv("UPLOAD_SIGNING_SECRET", "short");
    expect(() => getSigningSecret()).toThrow(/at least 32/);
    vi.stubEnv("UPLOAD_SIGNING_SECRET", SECRET);
    expect(getSigningSecret()).toBe(SECRET);
  });
});
