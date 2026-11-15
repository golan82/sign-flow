"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchOrders, type ApiResult } from "@/lib/orders/api-client";
import { mergeOrderSnapshot, upsertOrder } from "@/lib/orders/merge";
import type { OrderDto, OrdersSnapshot } from "@/lib/orders/types";

export type LiveStatus = "connecting" | "live" | "reconnecting";

const MAX_RECONNECT_DELAY_MS = 15_000;

/**
 * Order list kept current by an initial GET plus the SSE stream
 * (/api/orders/events). Every snapshot carries the database clock, from which
 * `clockOffsetMs` (server time minus local time) is derived for countdowns.
 */
export function useOrdersLive() {
  const [orders, setOrders] = useState<OrderDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");
  // Server clock from the latest snapshot and its offset from the local clock.
  const [clock, setClock] = useState({ offsetMs: 0, lastServerTimeMs: 0 });
  const latestRequest = useRef(0);

  const applySnapshot = useCallback((snapshot: OrdersSnapshot) => {
    setOrders((current) => mergeOrderSnapshot(current, snapshot.orders));
    const serverTimeMs = Date.parse(snapshot.serverTime);
    setClock({ offsetMs: serverTimeMs - Date.now(), lastServerTimeMs: serverTimeMs });
    setLoadError(null);
    setLoading(false);
  }, []);

  const applyListResult = useCallback(
    (requestId: number, result: ApiResult<OrdersSnapshot>) => {
      if (requestId !== latestRequest.current) return;
      if (result.ok) {
        applySnapshot(result.data);
      } else {
        setLoadError(result.error.message);
        setLoading(false);
      }
    },
    [applySnapshot],
  );

  // Initial load over plain HTTP, so errors can be shown and retried.
  useEffect(() => {
    let active = true;
    const requestId = ++latestRequest.current;
    fetchOrders().then((result) => {
      if (active) applyListResult(requestId, result);
    });
    return () => {
      active = false;
    };
  }, [applyListResult]);

  // Live updates. EventSource retries on its own while the connection is
  // "CONNECTING"; if the browser gives up ("CLOSED"), reconnect with backoff.
  // Every (re)connect starts with a full snapshot from the server.
  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let disposed = false;

    const connect = () => {
      source = new EventSource("/api/orders/events");
      source.addEventListener("open", () => {
        attempts = 0;
        setLiveStatus("live");
      });
      source.addEventListener("snapshot", (event) => {
        applySnapshot(JSON.parse((event as MessageEvent<string>).data) as OrdersSnapshot);
      });
      // Heartbeats carry the server's clock estimate; keep the offset fresh.
      source.addEventListener("heartbeat", (event) => {
        const { serverTime } = JSON.parse((event as MessageEvent<string>).data) as { serverTime: string };
        const serverTimeMs = Date.parse(serverTime);
        if (!Number.isNaN(serverTimeMs)) {
          setClock({ offsetMs: serverTimeMs - Date.now(), lastServerTimeMs: serverTimeMs });
        }
      });
      // The server ends each stream before its host's time limit (see
      // src/lib/realtime/sse.ts). Reconnect at once, without showing
      // "Reconnecting…"; the new stream starts with a full snapshot.
      source.addEventListener("reconnect", () => {
        source?.close();
        if (!disposed) connect();
      });
      source.addEventListener("error", () => {
        if (disposed) return;
        setLiveStatus("reconnecting");
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          const delay = Math.min(1_000 * 2 ** attempts++, MAX_RECONNECT_DELAY_MS);
          retryTimer = setTimeout(connect, delay);
        }
      });
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [applySnapshot]);

  /** Re-fetches over HTTP (used after this window's own mutations and for retry). */
  const reload = useCallback(() => {
    setLoading(true);
    const requestId = ++latestRequest.current;
    fetchOrders().then((result) => applyListResult(requestId, result));
  }, [applyListResult]);

  /** Shows an order returned by a mutation right away (if it is newer). */
  const applyOrder = useCallback((order: OrderDto) => {
    setOrders((current) => upsertOrder(current, order));
  }, []);

  return { orders, loading, loadError, liveStatus, clock, reload, applyOrder };
}

/**
 * Server-clock "now" in ms (local clock + measured offset), re-rendered every
 * second while `active`.
 *
 * The local clock is only read in timers, never during render (Next.js
 * prerenders this component). Until the first tick, and as a lower bound
 * afterwards, the server time of the latest snapshot is used.
 */
export function useServerNow(
  clock: { offsetMs: number; lastServerTimeMs: number },
  active: boolean,
): number {
  const [localNow, setLocalNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const tick = () => setLocalNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active]);
  return Math.max(localNow + clock.offsetMs, clock.lastServerTimeMs);
}
