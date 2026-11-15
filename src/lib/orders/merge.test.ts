import { describe, expect, it } from "vitest";

import { NO_CLAIM } from "@/lib/claims/claims";
import type { UploadDto } from "@/lib/uploads/types";

import { mergeOrderSnapshot, upsertOrder } from "./merge";
import type { OrderDto } from "./types";

const order = (id: string, version: number, title = id, uploads: UploadDto[] = []): OrderDto => ({
  id,
  title,
  description: null,
  status: "DRAFT",
  version,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  claim: NO_CLAIM,
  vendorId: null,
  uploads,
});

const upload = (id: string, status: UploadDto["status"], createdAt = "2026-01-01T00:00:00.000Z"): UploadDto => ({
  id,
  originalName: `${id}.pdf`,
  sizeBytes: 1,
  contentType: "application/pdf",
  status,
  createdAt,
  updatedAt: createdAt,
  expiresAt: "2026-01-01T00:30:00.000Z",
  completedAt: status === "COMPLETED" ? createdAt : null,
});

describe("mergeOrderSnapshot", () => {
  it("uses the snapshot when nothing is shown yet", () => {
    const incoming = [order("a", 1)];
    expect(mergeOrderSnapshot(null, incoming)).toBe(incoming);
  });

  it("takes newer versions, keeps newer local versions, follows snapshot membership and order", () => {
    const current = [order("a", 3, "local a"), order("b", 1, "local b"), order("gone", 1)];
    const incoming = [order("new", 0), order("b", 2, "server b"), order("a", 2, "server a")];

    expect(mergeOrderSnapshot(current, incoming).map((o) => o.title)).toEqual(["new", "server b", "local a"]);
  });

  it("applies an upload change even though order.version did not change", () => {
    const current = [order("a", 2, "a", [upload("u1", "PENDING_UPLOAD")])];
    const incoming = [order("a", 2, "a", [upload("u1", "COMPLETED")])];

    expect(mergeOrderSnapshot(current, incoming)[0].uploads[0].status).toBe("COMPLETED");
  });

  it("regression: a late, older response (same version) does not turn a completed upload back into pending", () => {
    // SSE already delivered the completion; then a GET read before it arrives.
    const current = [order("a", 2, "a", [upload("u1", "COMPLETED")])];
    const lateGet = [order("a", 2, "a", [upload("u1", "PENDING_UPLOAD")])];

    expect(mergeOrderSnapshot(current, lateGet)[0].uploads[0].status).toBe("COMPLETED");
  });

  it("keeps an upload the UI already knows that an older snapshot does not have yet, newest first", () => {
    const current = [order("a", 2, "a", [upload("new", "PENDING_UPLOAD", "2026-01-02T00:00:00.000Z")])];
    const older = [order("a", 2, "a", [upload("old", "COMPLETED")])];

    expect(mergeOrderSnapshot(current, older)[0].uploads.map((u) => u.id)).toEqual(["new", "old"]);
  });
});

describe("upsertOrder", () => {
  it("adds unknown orders first and replaces only with a newer or equal version", () => {
    const current = [order("a", 2, "a2")];
    expect(upsertOrder(current, order("b", 0)).map((o) => o.id)).toEqual(["b", "a"]);
    expect(upsertOrder(current, order("a", 1, "a1"))[0].title).toBe("a2");
    expect(upsertOrder(current, order("a", 3, "a3"))[0].title).toBe("a3");
  });

  it("keeps upload progress a mutation response does not know about", () => {
    const current = [order("a", 2, "a", [upload("u1", "COMPLETED")])];
    const response = order("a", 3, "a", [upload("u1", "PENDING_UPLOAD")]);

    const merged = upsertOrder(current, response)[0];
    expect(merged.version).toBe(3);
    expect(merged.uploads[0].status).toBe("COMPLETED");
  });
});
