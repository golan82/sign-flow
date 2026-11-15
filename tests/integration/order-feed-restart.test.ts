// Regression: a client that connects right after the last one left (e.g. a
// page reload) must get its initial snapshot even if a snapshot read from the
// previous feed generation was still running at that moment.
import { afterAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { getOrderFeedStats, subscribeToOrderFeed } from "@/lib/realtime/order-feed";

import { createTestOrder, deleteTrackedRecords, setStatusDirectly, withTestRecords } from "./helpers";

vi.mock("next/server", () => ({ connection: async () => {} }));

// Lets the test hold snapshot reads until it releases them.
const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
vi.mock("@/lib/orders/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orders/service")>();
  return {
    ...actual,
    getOrdersSnapshot: async () => {
      if (gate.wait) await gate.wait;
      return actual.getOrdersSnapshot();
    },
  };
});

afterAll(async () => {
  await deleteTrackedRecords();
  await prisma.$disconnect();
});

describe("order feed restart", () => {
  it("a new subscriber gets a snapshot even when a read from the stopped feed was in flight", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("feed restart");
      const first: unknown[] = [];
      const unsubscribeFirst = subscribeToOrderFeed((snapshot) => first.push(snapshot));
      await vi.waitFor(() => expect(first.length).toBeGreaterThan(0), { timeout: 5_000 });

      // Hold the next read, and trigger one with a database change.
      let release!: () => void;
      gate.wait = new Promise<void>((resolve) => (release = resolve));
      const readsBefore = getOrderFeedStats().reads;
      await setStatusDirectly(order.id, "SUBMITTED");
      await vi.waitFor(() => expect(getOrderFeedStats().reads).toBeGreaterThan(readsBefore), { timeout: 5_000 });

      // The last client leaves (feed stops) and a new one arrives at once.
      unsubscribeFirst();
      const second: { orders: { id: string; status: string }[] }[] = [];
      const unsubscribeSecond = subscribeToOrderFeed((snapshot) => second.push(snapshot));
      try {
        // Release the old read only after the new feed has opened its stream
        // and asked for its initial snapshot (that request must not be lost).
        await vi.waitFor(() => expect(getOrderFeedStats().status).toBe("watching"), { timeout: 5_000 });
        gate.wait = null;
        release();

        await vi.waitFor(
          () => {
            const latest = second.at(-1);
            expect(latest?.orders.find((o) => o.id === order.id)?.status).toBe("SUBMITTED");
          },
          { timeout: 5_000 },
        );
      } finally {
        unsubscribeSecond();
      }
      await vi.waitFor(() => expect(getOrderFeedStats().status).toBe("idle"));
    }));
});
