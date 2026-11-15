import { describe, expect, it } from "vitest";

import {
  canTransition,
  getAllowedTransitions,
  isTerminalStatus,
  ORDER_STATUSES,
  type OrderStatus,
} from "./status";

const FLOW: OrderStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "VENDOR_ACCEPTED",
  "IN_PRODUCTION",
  "READY_FOR_INSTALL",
  "COMPLETED",
];

const ALLOWED: [OrderStatus, OrderStatus][] = [
  ["DRAFT", "SUBMITTED"],
  ["SUBMITTED", "VENDOR_ACCEPTED"],
  ["VENDOR_ACCEPTED", "IN_PRODUCTION"],
  ["IN_PRODUCTION", "READY_FOR_INSTALL"],
  ["READY_FOR_INSTALL", "COMPLETED"],
  ["DRAFT", "CANCELLED"],
  ["SUBMITTED", "CANCELLED"],
  ["VENDOR_ACCEPTED", "CANCELLED"],
];

const isListed = (from: OrderStatus, to: OrderStatus) =>
  ALLOWED.some(([f, t]) => f === from && t === to);

describe("order status transitions", () => {
  it.each(ALLOWED)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it("allows exactly the listed transitions (all 49 pairs)", () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(isListed(from, to));
      }
    }
  });

  it("rejects skipping steps", () => {
    for (let i = 0; i < FLOW.length; i++) {
      for (let j = i + 2; j < FLOW.length; j++) {
        expect(canTransition(FLOW[i], FLOW[j]), `${FLOW[i]} -> ${FLOW[j]}`).toBe(false);
      }
    }
    expect(canTransition("DRAFT", "IN_PRODUCTION")).toBe(false);
  });

  it("rejects moving backwards", () => {
    for (let i = 1; i < FLOW.length; i++) {
      for (let j = 0; j < i; j++) {
        expect(canTransition(FLOW[i], FLOW[j]), `${FLOW[i]} -> ${FLOW[j]}`).toBe(false);
      }
    }
  });

  it("rejects transitions to the same status", () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });

  it("rejects cancelling once production has started", () => {
    expect(canTransition("IN_PRODUCTION", "CANCELLED")).toBe(false);
    expect(canTransition("READY_FOR_INSTALL", "CANCELLED")).toBe(false);
    expect(canTransition("COMPLETED", "CANCELLED")).toBe(false);
  });

  it("treats COMPLETED and CANCELLED as final", () => {
    for (const status of ["COMPLETED", "CANCELLED"] as const) {
      expect(isTerminalStatus(status)).toBe(true);
      expect(getAllowedTransitions(status)).toEqual([]);
      for (const to of ORDER_STATUSES) {
        expect(canTransition(status, to), `${status} -> ${to}`).toBe(false);
      }
    }
  });

  it("treats every other status as non-final", () => {
    for (const status of ORDER_STATUSES) {
      if (status === "COMPLETED" || status === "CANCELLED") continue;
      expect(isTerminalStatus(status), status).toBe(false);
    }
  });
});
