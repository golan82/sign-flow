import { connection } from "next/server";

import { createOrderEventStream } from "@/lib/realtime/sse";

// Hosts that limit request duration (Vercel Hobby: at most 300 s, streamed
// responses included) read this from the build output. The stream ends
// itself 20 s earlier with a `reconnect` event, so its cleanup always runs in
// our code and the client reconnects before the platform cuts it off.
export const maxDuration = 300;
const STREAM_END_MARGIN_S = 20;

// Server-Sent Events stream of order snapshots, pushed from MongoDB Change
// Streams (see src/lib/realtime/order-feed.ts). Public order fields only.
export async function GET(request: Request) {
  await connection();
  return createOrderEventStream(request, { maxStreamMs: (maxDuration - STREAM_END_MARGIN_S) * 1000 });
}
