import "server-only";

import { MongoClient, type ChangeStream, type ResumeToken } from "mongodb";

import { getOrdersSnapshot } from "@/lib/orders/service";
import type { OrderDto, OrdersSnapshot } from "@/lib/orders/types";

// Push-based order feed for SSE clients, built on MongoDB Change Streams.
//
// - ONE change stream per server process, shared by all SSE clients, opened
//   when the first client subscribes and closed when the last one leaves.
// - It watches the `orders` and `uploads` collections of the database, so
//   writes from any process (this app, the claim-expiry worker, other app
//   instances) arrive as events. No timer ever queries the orders.
// - A change event only signals "something changed": the feed then re-reads
//   the public snapshot (DTOs only, never raw documents) and pushes it to
//   every client if it differs from the last one. Bursts of events are
//   coalesced into one read at a time.
// - Startup race: the stream is opened and its cursor established BEFORE the
//   first snapshot is read, so a write can never fall between the snapshot
//   and the stream. A write during that window shows up in both, which is
//   harmless.
// - If the stream fails, it is reopened with exponential backoff, resuming
//   after the last seen resume token. If the server rejects the token (for
//   example it fell out of the oplog), the feed reopens without it and does a
//   full re-sync.

const WATCHED_COLLECTIONS = ["orders", "uploads"];
const RETRY_BASE_MS = Number(process.env.REALTIME_RETRY_BASE_MS) || 1_000;
const RETRY_MAX_MS = 30_000;

export type FeedListener = (snapshot: OrdersSnapshot) => void;
export type FeedStatus = "idle" | "starting" | "watching" | "retrying";

type CachedSnapshot = {
  orders: OrderDto[];
  /** MongoDB time when the snapshot was read, and this process's monotonic clock then. */
  dbTimeMs: number;
  readAtMonotonicMs: number;
};

type FeedState = {
  listeners: Set<FeedListener>;
  status: FeedStatus;
  /** Incremented on every stop; async work from an older generation is ignored. */
  generation: number;
  client: MongoClient | null;
  stream: ChangeStream | null;
  resumeToken: ResumeToken | null;
  snapshot: CachedSnapshot | null;
  ordersKey: string | null;
  /** Generation of the snapshot read in progress, if any. */
  refreshingGeneration: number | null;
  refreshAgain: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
  counters: {
    events: number;
    reads: number;
    fullSyncs: number;
    resumes: number;
    rejectedResumeTokens: number;
    streamFailures: number;
  };
};

// Kept on globalThis so dev hot reloads reuse one feed instead of leaking streams.
const globalForFeed = globalThis as unknown as { orderFeed?: FeedState };
const state: FeedState = (globalForFeed.orderFeed ??= {
  listeners: new Set(),
  status: "idle",
  generation: 0,
  client: null,
  stream: null,
  resumeToken: null,
  snapshot: null,
  ordersKey: null,
  refreshingGeneration: null,
  refreshAgain: false,
  retryTimer: null,
  retryAttempt: 0,
  counters: { events: 0, reads: 0, fullSyncs: 0, resumes: 0, rejectedResumeTokens: 0, streamFailures: 0 },
});

/** Best estimate of MongoDB's current time, without a database round trip. */
export function estimateServerTime(): string | null {
  if (!state.snapshot) return null;
  const elapsed = performance.now() - state.snapshot.readAtMonotonicMs;
  return new Date(state.snapshot.dbTimeMs + elapsed).toISOString();
}

function currentSnapshot(): OrdersSnapshot | null {
  const serverTime = estimateServerTime();
  return state.snapshot && serverTime ? { orders: state.snapshot.orders, serverTime } : null;
}

/**
 * Registers a listener. It receives the current snapshot right away (or as
 * soon as the first one is read) and then every change. Returns an
 * idempotent unsubscribe; the change stream closes when the last listener leaves.
 */
export function subscribeToOrderFeed(listener: FeedListener): () => void {
  state.listeners.add(listener);
  if (state.status === "idle") {
    void start();
  } else {
    const snapshot = currentSnapshot();
    if (snapshot) listener(snapshot);
  }
  return () => {
    if (!state.listeners.delete(listener)) return;
    if (state.listeners.size === 0) void stop();
  };
}

async function start() {
  const generation = ++state.generation;
  state.status = "starting";
  // Fail fast when the database is down; the feed retries with backoff.
  state.client = new MongoClient(requireDatabaseUrl(), { serverSelectionTimeoutMS: 5_000 });
  await openStream(generation, null);
}

async function stop() {
  state.generation++;
  state.status = "idle";
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.retryTimer = null;
  state.retryAttempt = 0;
  const { stream, client } = state;
  state.stream = null;
  state.client = null;
  // Nobody is watching any more, so the cached snapshot would go stale.
  state.snapshot = null;
  state.ordersKey = null;
  state.resumeToken = null;
  await stream?.close().catch(() => {});
  await client?.close().catch(() => {});
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/**
 * Opens the change stream (resuming after `resumeToken` if given), waits
 * until its cursor exists, then starts consuming events. Without a resume
 * token this is a full sync: the snapshot is read after the cursor exists.
 */
async function openStream(generation: number, resumeToken: ResumeToken | null): Promise<void> {
  const client = state.client;
  if (!client || generation !== state.generation) return;
  const stream = client
    .db()
    .watch([{ $match: { "ns.coll": { $in: WATCHED_COLLECTIONS } } }, { $project: { _id: 1 } }], {
      ...(resumeToken ? { resumeAfter: resumeToken } : {}),
    });

  let firstEvent: unknown;
  try {
    firstEvent = await stream.tryNext(); // establishes the cursor
  } catch (error) {
    await stream.close().catch(() => {});
    if (generation !== state.generation) return;
    if (resumeToken) {
      // The token is unusable (expired from the oplog, malformed, ...).
      state.counters.rejectedResumeTokens++;
      state.resumeToken = null;
      console.warn("[feed] resume token rejected; reopening with a full sync", error);
      return openStream(generation, null);
    }
    return scheduleRetry(generation, error);
  }
  if (generation !== state.generation) {
    await stream.close().catch(() => {});
    return;
  }

  state.stream = stream;
  state.resumeToken = stream.resumeToken;
  state.status = "watching";
  state.retryAttempt = 0;
  if (resumeToken) {
    state.counters.resumes++;
  } else {
    state.counters.fullSyncs++;
    requestRefresh(generation);
  }
  if (firstEvent) onChange(generation, stream);
  void consume(generation, stream);
}

async function consume(generation: number, stream: ChangeStream) {
  try {
    while (generation === state.generation && state.stream === stream) {
      await stream.next(); // waits for the next event; the driver resumes transient errors itself
      if (generation !== state.generation || state.stream !== stream) return;
      onChange(generation, stream);
    }
  } catch (error) {
    if (generation !== state.generation || state.stream !== stream) return; // closed on purpose
    state.counters.streamFailures++;
    state.stream = null;
    await stream.close().catch(() => {});
    scheduleRetry(generation, error);
  }
}

function onChange(generation: number, stream: ChangeStream) {
  state.counters.events++;
  state.resumeToken = stream.resumeToken;
  requestRefresh(generation);
}

function scheduleRetry(generation: number, error: unknown) {
  if (generation !== state.generation) return;
  state.status = "retrying";
  const delay = Math.min(RETRY_BASE_MS * 2 ** state.retryAttempt++, RETRY_MAX_MS);
  console.error(`[feed] change stream unavailable; retrying in ${delay} ms`, error);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    void openStream(generation, state.resumeToken);
  }, delay);
}

/**
 * Re-reads the snapshot after a change; concurrent requests collapse into one
 * extra read. Only a read of the SAME generation absorbs a request: a read
 * still running from before a stop/start is about to be discarded, so the new
 * generation starts its own (otherwise a client that reconnects right after
 * the last one left would never get its initial snapshot).
 */
function requestRefresh(generation: number) {
  if (state.refreshingGeneration === generation) {
    state.refreshAgain = true;
    return;
  }
  state.refreshingGeneration = generation;
  void (async () => {
    try {
      do {
        state.refreshAgain = false;
        state.counters.reads++;
        const startedAt = performance.now();
        const snapshot = await getOrdersSnapshot();
        if (generation !== state.generation) return;
        const dbTimeMs = Date.parse(snapshot.serverTime);
        state.snapshot = { orders: snapshot.orders, dbTimeMs, readAtMonotonicMs: startedAt };
        const key = JSON.stringify(snapshot.orders);
        if (key !== state.ordersKey) {
          state.ordersKey = key;
          const fresh = currentSnapshot()!;
          for (const listener of state.listeners) listener(fresh);
        }
      } while (state.refreshAgain && generation === state.generation);
    } catch (error) {
      // Treat a failed read like a failed stream: reconnect and re-sync fully.
      if (generation === state.generation) {
        state.resumeToken = null;
        const stream = state.stream;
        state.stream = null;
        await stream?.close().catch(() => {});
        scheduleRetry(generation, error);
      }
    } finally {
      if (state.refreshingGeneration === generation) state.refreshingGeneration = null;
    }
  })();
}

/** Diagnostics and tests. */
export function getOrderFeedStats() {
  return {
    listeners: state.listeners.size,
    status: state.status,
    hasStream: state.stream !== null,
    hasClient: state.client !== null,
    retryPending: state.retryTimer !== null,
    ...state.counters,
  };
}

/** Test hooks: simulate a failed stream and an unusable resume token. */
export const orderFeedTestHooks = {
  async failStream() {
    const stream = state.stream;
    if (!stream) throw new Error("no open stream");
    await stream.close(); // the consume loop sees a closed stream it did not close itself
  },
  setResumeToken(token: ResumeToken) {
    state.resumeToken = token;
  },
};
