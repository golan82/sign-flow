import { describe, expect, it } from "vitest";

import { changeStatusSchema, createOrderSchema, orderIdSchema } from "./schemas";

describe("createOrderSchema", () => {
  it("trims the title and drops a blank description", () => {
    expect(createOrderSchema.parse({ title: "  Shop sign  ", description: "   " })).toEqual({
      title: "Shop sign",
      description: undefined,
    });
  });

  it("enforces title length 1-120 after trimming", () => {
    expect(createOrderSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(createOrderSchema.safeParse({ title: "a".repeat(120) }).success).toBe(true);
    expect(createOrderSchema.safeParse({ title: ` ${"a".repeat(120)} ` }).success).toBe(true);
    expect(createOrderSchema.safeParse({ title: "a".repeat(121) }).success).toBe(false);
  });

  it("limits the description to 2000 characters", () => {
    expect(createOrderSchema.safeParse({ title: "t", description: "d".repeat(2000) }).success).toBe(true);
    expect(createOrderSchema.safeParse({ title: "t", description: "d".repeat(2001) }).success).toBe(false);
  });

  it("rejects client-controlled and unknown fields", () => {
    expect(createOrderSchema.safeParse({ title: "t", status: "COMPLETED" }).success).toBe(false);
    expect(createOrderSchema.safeParse({ title: "t", version: 5 }).success).toBe(false);
  });
});

describe("changeStatusSchema", () => {
  it("accepts a known status and a non-negative integer version", () => {
    expect(changeStatusSchema.safeParse({ targetStatus: "SUBMITTED", expectedVersion: 0 }).success).toBe(true);
  });

  it.each([
    { targetStatus: "SHIPPED", expectedVersion: 0 },
    { targetStatus: "SUBMITTED", expectedVersion: -1 },
    { targetStatus: "SUBMITTED", expectedVersion: 1.5 },
    { targetStatus: "SUBMITTED", expectedVersion: "0" },
    { targetStatus: "SUBMITTED" },
    { targetStatus: "SUBMITTED", expectedVersion: 0, extra: true },
  ])("rejects %o", (input) => {
    expect(changeStatusSchema.safeParse(input).success).toBe(false);
  });
});

describe("orderIdSchema", () => {
  it("accepts only 24-character hex ObjectIds", () => {
    expect(orderIdSchema.safeParse("6650f1c2a1b2c3d4e5f60003").success).toBe(true);
    expect(orderIdSchema.safeParse("not-an-id").success).toBe(false);
    expect(orderIdSchema.safeParse("6650f1c2a1b2c3d4e5f6000").success).toBe(false);
    expect(orderIdSchema.safeParse("6650f1c2a1b2c3d4e5f6000z").success).toBe(false);
  });
});
