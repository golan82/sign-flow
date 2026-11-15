import path from "node:path";

import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  // Same variables Next.js and the Prisma CLI read from .env.
  const env = loadEnv(mode, process.cwd(), "");

  return {
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        // `server-only` throws outside React Server Components; tests run in Node.
        "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts"),
      },
    },
    test: {
      environment: "node",
      projects: [
        {
          test: {
            name: "unit",
            include: ["src/**/*.test.ts", "tests/support/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "integration",
            include: ["tests/integration/**/*.test.ts"],
            setupFiles: ["tests/integration/setup.ts"],
            env: {
              ...env,
              // Integration tests always use the test database, never the
              // development one. setup.ts refuses to run if this is unsafe.
              DATABASE_URL: env.TEST_DATABASE_URL ?? "",
              DEV_DATABASE_URL: env.DATABASE_URL ?? "",
              // Short change-stream retry backoff and SSE heartbeat for tests.
              REALTIME_RETRY_BASE_MS: "50",
              SSE_HEARTBEAT_MS: "200",
            },
            testTimeout: 30_000,
            hookTimeout: 30_000,
            // Tests share one database; run files one at a time.
            fileParallelism: false,
          },
        },
      ],
    },
  };
});
