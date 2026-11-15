import "server-only";

import { estimateServerTime, subscribeToOrderFeed } from "./order-feed";

const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS) || 15_000;
const RECONNECT_DELAY_MS = 3_000;

let openStreams = 0;

/** Number of SSE responses currently open in this process (tests, diagnostics). */
export function getOpenEventStreamCount() {
  return openStreams;
}

/**
 * Server-Sent Events response for the order feed.
 * - `snapshot`: { orders, serverTime } with public DTOs only.
 * - `heartbeat`: { serverTime } every HEARTBEAT_MS; keeps proxies from closing
 *   the connection and refreshes the client's clock offset. It never queries
 *   the database (serverTime is estimated from the last snapshot).
 * - `reconnect`: sent when the stream reaches `maxStreamMs`, just before the
 *   server closes it. The client reconnects at once and gets a full snapshot.
 *   Ending the stream here, before the platform's time limit (Vercel: the
 *   route's maxDuration), keeps the cleanup in this code instead of relying on
 *   the platform cutting the request off.
 * Everything is released when the client disconnects or the stream ends.
 */
export function createOrderEventStream(request: Request, { maxStreamMs }: { maxStreamMs?: number } = {}): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      openStreams++;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      write(`retry: ${RECONNECT_DELAY_MS}\n\n`);
      const unsubscribe = subscribeToOrderFeed((snapshot) => {
        write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      });
      const heartbeat = setInterval(() => {
        const serverTime = estimateServerTime();
        write(serverTime ? `event: heartbeat\ndata: ${JSON.stringify({ serverTime })}\n\n` : ": heartbeat\n\n");
      }, HEARTBEAT_MS);
      const lifetime = maxStreamMs
        ? setTimeout(() => {
            write("event: reconnect\ndata: {}\n\n");
            cleanup();
          }, maxStreamMs)
        : undefined;

      cleanup = () => {
        if (closed) return;
        closed = true;
        openStreams--;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
