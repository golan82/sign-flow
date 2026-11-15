// Background process that releases expired installer claims.
//
//   npm run worker:claims            run until stopped (Ctrl+C)
//   npm run worker:claims -- --once  run a single sweep and exit
//
// Uses DATABASE_URL (from .env unless already set). Safe to run as several
// instances at once: every release is a conditional update (see
// src/lib/claims/store.mts). Stops gracefully on SIGINT/SIGTERM/SIGBREAK:
// the current sweep finishes, then the database connection is closed.
import prismaClient from "@prisma/client";

import { releaseExpiredClaims, runClaimExpiryWorker } from "../src/lib/claims/store.mts";

const intervalMs = Number(process.env.CLAIM_SWEEP_INTERVAL_MS ?? 5_000);
if (!Number.isFinite(intervalMs) || intervalMs < 100) {
  throw new Error(`Invalid CLAIM_SWEEP_INTERVAL_MS: ${process.env.CLAIM_SWEEP_INTERVAL_MS}`);
}

// @prisma/client is CommonJS; see scripts/db-smoke-test.mts.
const { PrismaClient } = prismaClient;
const db = new PrismaClient();
const log = (message: string) => console.log(`[claim-expiry] ${new Date().toISOString()} ${message}`);

try {
  if (process.argv.includes("--once")) {
    const { candidates, released } = await releaseExpiredClaims(db);
    log(`single sweep: ${candidates} candidate(s), released ${released.length}`);
  } else {
    const controller = new AbortController();
    const stop = (signal: string) => {
      if (controller.signal.aborted) return;
      log(`${signal} received, stopping after the current sweep`);
      controller.abort();
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
      process.once(signal, () => stop(signal));
    }
    log(`started, sweeping every ${intervalMs} ms`);
    await runClaimExpiryWorker({ db, intervalMs, signal: controller.signal, log });
    log("stopped");
  }
} finally {
  await db.$disconnect();
}
