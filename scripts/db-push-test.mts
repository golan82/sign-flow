// Applies prisma/schema.prisma to the test database (TEST_DATABASE_URL).
// Run with: npm run db:push:test  (also runs before npm run test:integration)
import { spawnSync } from "node:child_process";
import path from "node:path";

import { assertSafeTestDatabase } from "../tests/support/test-database.mts";

const projectRoot = path.resolve(import.meta.dirname, "..");
const testUrl = process.env.TEST_DATABASE_URL;
const database = assertSafeTestDatabase(testUrl, process.env.DATABASE_URL);
console.log(`Applying schema to test database "${database}"`);

const result = spawnSync(
  process.execPath,
  [path.join(projectRoot, "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate"],
  // The Prisma CLI does not override variables that are already set, so this
  // DATABASE_URL wins over the development value in .env.
  { cwd: projectRoot, stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
process.exitCode = result.status ?? 1;
