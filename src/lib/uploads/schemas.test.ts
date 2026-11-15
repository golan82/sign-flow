import { describe, expect, it } from "vitest";

import { MAX_UPLOAD_BYTES } from "./constants";
import { authorizeUploadSchema } from "./schemas";

const valid = {
  clientRequestId: "6f1d2c1e-8a8b-4a43-9b11-5d0c2b3a4f10",
  originalName: "storefront-banner.pdf",
  sizeBytes: 1_610_612_736,
  contentType: "application/pdf",
};

describe("authorizeUploadSchema", () => {
  it("accepts a valid 1.5 GB PDF and trims the name", () => {
    expect(authorizeUploadSchema.parse({ ...valid, originalName: "  storefront-banner.pdf " }).originalName).toBe(
      "storefront-banner.pdf",
    );
  });

  it("accepts the maximum size and rejects one byte more, zero and fractions", () => {
    expect(authorizeUploadSchema.safeParse({ ...valid, sizeBytes: MAX_UPLOAD_BYTES }).success).toBe(true);
    for (const sizeBytes of [MAX_UPLOAD_BYTES + 1, 0, -1, 1.5]) {
      expect(authorizeUploadSchema.safeParse({ ...valid, sizeBytes }).success, String(sizeBytes)).toBe(false);
    }
  });

  it.each([
    ["path separators", "../etc/passwd.pdf"],
    ["backslashes", "..\\evil.pdf"],
    ["control characters", "bad\u0000name.pdf"],
    ["an extension that does not match the type", "banner.exe"],
    ["no extension", "banner"],
    ["a blank name", "   "],
    ["a too long name", `${"a".repeat(200)}.pdf`],
  ])("rejects names with %s", (_label, originalName) => {
    expect(authorizeUploadSchema.safeParse({ ...valid, originalName }).success).toBe(false);
  });

  it("rejects unsupported content types, bad request ids and unexpected fields", () => {
    expect(authorizeUploadSchema.safeParse({ ...valid, contentType: "application/x-msdownload" }).success).toBe(false);
    expect(authorizeUploadSchema.safeParse({ ...valid, clientRequestId: "1" }).success).toBe(false);
    expect(authorizeUploadSchema.safeParse({ ...valid, storageKey: "mine" }).success).toBe(false);
  });

  it("matches extensions case-insensitively per type", () => {
    expect(authorizeUploadSchema.safeParse({ ...valid, originalName: "LOGO.AI", contentType: "application/postscript" }).success).toBe(true);
    expect(authorizeUploadSchema.safeParse({ ...valid, originalName: "logo.ai", contentType: "application/pdf" }).success).toBe(false);
  });
});
