// SSE live updates (GET /api/orders/events) pushed from MongoDB Change
// Streams, against the real test database.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST as claimHandler } from "@/app/api/orders/[id]/claim/route";
import { GET as eventsHandler, maxDuration as eventsRouteMaxDuration } from "@/app/api/orders/events/route";
import { POST as completeHandler } from "@/app/api/orders/[id]/uploads/[uploadId]/complete/route";
import { POST as authorizeHandler } from "@/app/api/orders/[id]/uploads/route";
import type { OrderDto, OrdersSnapshot } from "@/lib/orders/types";
import { prisma } from "@/lib/prisma";
import { getOrderFeedStats, orderFeedTestHooks } from "@/lib/realtime/order-feed";
import { createOrderEventStream, getOpenEventStreamCount } from "@/lib/realtime/sse";
import type { UploadAuthorization } from "@/lib/uploads/types";

import {
  createTestOrder,
  deleteTrackedRecords,
  jsonRequest,
  setStatusDirectly,
  toJson,
  trackUploadId,
  withTestRecords,
} from "./helpers";

vi.mock("next/server", () => ({ connection: async () => {} }));

type EventStream = {
  raw: () => string;
  heartbeats: () => number;
  waitForSnapshot: (predicate: (s: OrdersSnapshot) => boolean, label: string) => Promise<OrdersSnapshot>;
  close: () => Promise<void>;
};

/** Opens the SSE route like a browser tab would and parses its events. */
async function openEventStream(): Promise<EventStream> {
  const controller = new AbortController();
  const response = await eventsHandler(new Request("http://localhost/api/orders/events", { signal: controller.signal }));
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const snapshots: OrdersSnapshot[] = [];
  let heartbeats = 0;
  let text = "";
  let buffer = "";
  let closed = false;

  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        text += chunk;
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event === "snapshot" && data) snapshots.push(JSON.parse(data));
          if (event === "heartbeat") heartbeats++;
        }
      }
    } catch {
      // reader cancelled
    }
  })();

  return {
    raw: () => text,
    heartbeats: () => heartbeats,
    async waitForSnapshot(predicate, label) {
      let found: OrdersSnapshot | undefined;
      await vi.waitFor(
        () => {
          found = [...snapshots].reverse().find(predicate);
          if (!found) throw new Error(`no snapshot yet: ${label}`);
        },
        { timeout: 8_000, interval: 20 },
      );
      return found!;
    },
    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

const findOrder = (snapshot: OrdersSnapshot, id: string): OrderDto | undefined =>
  snapshot.orders.find((order) => order.id === id);
const activeTimeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

let timeoutsBefore = 0;
beforeAll(() => {
  timeoutsBefore = activeTimeouts();
});

afterAll(async () => {
  await deleteTrackedRecords();
  await prisma.$disconnect();
});

describe("GET /api/orders/events (Change Streams)", () => {
  it("pushes database changes to two clients without polling, incl. upload completion", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("sse push");
      await setStatusDirectly(order.id, "READY_FOR_INSTALL");
      const windowA = await openEventStream();
      const windowB = await openEventStream();
      try {
        for (const window of [windowA, windowB]) {
          const initial = await window.waitForSnapshot((s) => !!findOrder(s, order.id), "initial");
          expect(Date.parse(initial.serverTime)).not.toBeNaN();
        }
        expect(getOrderFeedStats()).toMatchObject({ listeners: 2, status: "watching", hasStream: true });

        // No writes -> no reads: nothing polls the database on a timer, and
        // heartbeats (every 200 ms here) do not query it either.
        const readsWhenIdle = getOrderFeedStats().reads;
        const heartbeatsBefore = windowA.heartbeats();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(getOrderFeedStats().reads).toBe(readsWhenIdle);
        expect(windowA.heartbeats()).toBeGreaterThan(heartbeatsBefore);

        // A claim written in "window A" reaches window B through the change stream.
        const claim = await toJson<{ claimToken: string }>(
          await claimHandler(
            jsonRequest(`http://localhost/api/orders/${order.id}/claim`, "POST", { installerId: "installer-sam" }),
            { params: Promise.resolve({ id: order.id }) },
          ),
        );
        expect(claim.status).toBe(201);
        await windowB.waitForSnapshot((s) => findOrder(s, order.id)?.claim.state === "PENDING_VERIFICATION", "claim");

        // An upload is authorized and completed; both clients see the final metadata.
        const auth = await toJson<UploadAuthorization>(
          await authorizeHandler(
            jsonRequest(`http://localhost/api/orders/${order.id}/uploads`, "POST", {
              clientRequestId: randomUUID(),
              originalName: "banner.pdf",
              sizeBytes: 1_610_612_736,
              contentType: "application/pdf",
            }),
            { params: Promise.resolve({ id: order.id }) },
          ),
        );
        trackUploadId(auth.body.upload.id);
        const done = await completeHandler(
          jsonRequest("http://localhost/x", "POST", { uploadUrl: auth.body.uploadUrl }),
          { params: Promise.resolve({ id: order.id, uploadId: auth.body.upload.id }) },
        );
        expect(done.status).toBe(200);
        for (const window of [windowA, windowB]) {
          const snap = await window.waitForSnapshot(
            (s) => findOrder(s, order.id)?.uploads[0]?.status === "COMPLETED",
            "upload completed",
          );
          expect(findOrder(snap, order.id)!.uploads[0]).toMatchObject({ originalName: "banner.pdf", sizeBytes: 1_610_612_736 });
        }

        // Nothing secret or internal is ever written to the stream.
        const stored = await prisma.upload.findUniqueOrThrow({ where: { id: auth.body.upload.id } });
        const signature = new URL(auth.body.uploadUrl).searchParams.get("X-Signature")!;
        for (const window of [windowA, windowB]) {
          const raw = window.raw();
          for (const secret of [claim.body.claimToken, signature, stored.storageKey, stored.clientRequestId]) {
            expect(raw).not.toContain(secret);
          }
          expect(raw).not.toMatch(/claimTokenHash|storageKey|uploadUrl|X-Signature|clientRequestId|"_id"|operationType/);
        }
      } finally {
        await windowA.close();
        await windowB.close();
      }
    }));

  it("delivers a change made by the separate expiry worker process", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("sse worker");
      await setStatusDirectly(order.id, "READY_FOR_INSTALL");
      const window = await openEventStream();
      try {
        await window.waitForSnapshot((s) => !!findOrder(s, order.id), "initial");
        await claimHandler(
          jsonRequest(`http://localhost/api/orders/${order.id}/claim`, "POST", { installerId: "installer-alex" }),
          { params: Promise.resolve({ id: order.id }) },
        );
        await window.waitForSnapshot((s) => findOrder(s, order.id)?.claim.state === "PENDING_VERIFICATION", "claimed");
        await prisma.order.update({ where: { id: order.id }, data: { claimExpiresAt: new Date(Date.now() - 1_000) } });

        const { stdout } = await promisify(execFile)(
          process.execPath,
          [path.resolve("scripts/claim-expiry-worker.mts"), "--once"],
          { env: { ...process.env } },
        );
        expect(stdout).toMatch(/released [1-9]/);
        await window.waitForSnapshot((s) => findOrder(s, order.id)?.claim.state === "NONE", "released by worker");
      } finally {
        await window.close();
      }
    }));

  it("a reconnecting client gets the current state, including changes made while it was away", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("sse reconnect");
      const keepAlive = await openEventStream(); // keeps the shared watcher running
      const window = await openEventStream();
      try {
        await window.waitForSnapshot((s) => !!findOrder(s, order.id), "initial");
        await window.close();
        await setStatusDirectly(order.id, "SUBMITTED");
        await keepAlive.waitForSnapshot((s) => findOrder(s, order.id)?.status === "SUBMITTED", "change seen");

        const again = await openEventStream();
        try {
          const first = await again.waitForSnapshot((s) => !!findOrder(s, order.id), "after reconnect");
          expect(findOrder(first, order.id)?.status).toBe("SUBMITTED");
        } finally {
          await again.close();
        }
      } finally {
        await keepAlive.close();
      }
    }));

  it("after a stream failure it resumes with the resume token and catches up on missed changes", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("sse resume");
      const window = await openEventStream();
      try {
        await window.waitForSnapshot((s) => !!findOrder(s, order.id), "initial");
        const before = getOrderFeedStats();

        await orderFeedTestHooks.failStream();
        await setStatusDirectly(order.id, "SUBMITTED"); // while the stream is down

        await window.waitForSnapshot((s) => findOrder(s, order.id)?.status === "SUBMITTED", "caught up");
        const after = getOrderFeedStats();
        expect(after.streamFailures).toBe(before.streamFailures + 1);
        expect(after.resumes).toBe(before.resumes + 1);
        expect(after.fullSyncs).toBe(before.fullSyncs);
        expect(after.status).toBe("watching");
      } finally {
        await window.close();
      }
    }));

  it("falls back to a full re-sync when the resume token is rejected", () =>
    withTestRecords(async () => {
      const order = await createTestOrder("sse bad token");
      const window = await openEventStream();
      try {
        await window.waitForSnapshot((s) => !!findOrder(s, order.id), "initial");
        const before = getOrderFeedStats();

        orderFeedTestHooks.setResumeToken({ _data: "zz" });
        await orderFeedTestHooks.failStream();
        await setStatusDirectly(order.id, "SUBMITTED");

        await window.waitForSnapshot((s) => findOrder(s, order.id)?.status === "SUBMITTED", "re-synced");
        const after = getOrderFeedStats();
        expect(after.rejectedResumeTokens).toBe(before.rejectedResumeTokens + 1);
        expect(after.fullSyncs).toBe(before.fullSyncs + 1);
        expect(after.status).toBe("watching");
      } finally {
        await window.close();
      }
    }));

  /** Reads a stream that the server ends by itself; returns its text and duration. */
  async function readUntilServerCloses(maxStreamMs: number) {
    const response = createOrderEventStream(new Request("http://localhost/api/orders/events"), { maxStreamMs });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const started = Date.now();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return { text, ms: Date.now() - started };
  }

  it("ends a stream at its maximum lifetime with a reconnect event and releases it", async () => {
    // The route ends streams before its maxDuration (Vercel Hobby: 300 s).
    expect(eventsRouteMaxDuration).toBeLessThanOrEqual(300);
    const { text, ms } = await readUntilServerCloses(3_000);
    expect(ms).toBeGreaterThanOrEqual(2_900);
    expect(text).toContain("event: snapshot");
    expect(text.trimEnd().endsWith("event: reconnect\ndata: {}")).toBe(true);
    expect(getOpenEventStreamCount()).toBe(0);
  });

  it("a stream that ends while the feed is still starting leaves no database client behind", async () => {
    // The server ends this stream before the feed has finished starting; the
    // next test checks that no listener, stream, client or timer is left.
    await vi.waitFor(() => expect(getOrderFeedStats().status).toBe("idle"), { timeout: 5_000 });
    const { text } = await readUntilServerCloses(20);
    expect(text).toContain("event: reconnect");
    expect(getOpenEventStreamCount()).toBe(0);
  });

  it("leaves no listeners, streams, clients or timers behind once every client is gone", async () => {
    await vi.waitFor(() => expect(getOrderFeedStats().status).toBe("idle"), { timeout: 5_000 });
    expect(getOrderFeedStats()).toMatchObject({
      listeners: 0,
      hasStream: false,
      hasClient: false,
      retryPending: false,
    });
    expect(getOpenEventStreamCount()).toBe(0);
    // Heartbeat intervals, retry timers and the driver's monitoring timers are
    // all gone. Polled with a plain loop: vi.waitFor's own interval and timeout
    // timers would be counted too and could never let the check pass. Socket
    // close timers of the closed client may need a moment.
    let remaining = activeTimeouts();
    for (let waited = 0; remaining > timeoutsBefore && waited < 5_000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      remaining = activeTimeouts();
    }
    expect(remaining).toBeLessThanOrEqual(timeoutsBefore);
  });
});
