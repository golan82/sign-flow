// Verifies that an order survives a restart of this project's MongoDB service:
// create one dedicated test order, stop and start only the `mongodb` service
// of this compose project (data volumes are kept), read the same id back, and
// always delete that order at the end.
// Run with: npm run test:db:persistence
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

// @prisma/client is CommonJS with re-exported members that Node's ESM loader
// cannot detect as named exports, so import the default and destructure.
import prismaClient from "@prisma/client";

import { assertSafeTestDatabase } from "../tests/support/test-database.mts";

const testUrl = process.env.TEST_DATABASE_URL;
assertSafeTestDatabase(testUrl, process.env.DATABASE_URL);

const { PrismaClient } = prismaClient;
const projectRoot = path.resolve(import.meta.dirname, "..");
const title = `db-persistence-check ${randomUUID()}`;
let createdId: string | undefined;

// The local development MongoDB (not the full Docker run in docker-compose.yml).
function compose(...args: string[]) {
  console.log(`> docker compose -f compose.dev.yaml ${args.join(" ")}`);
  execFileSync("docker", ["compose", "-f", "compose.dev.yaml", ...args], { cwd: projectRoot, stdio: "inherit" });
}

let prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  const created = await prisma.order.create({ data: { title } });
  createdId = created.id;
  console.log(`created: ${created.id}`);
  await prisma.$disconnect();

  compose("stop", "mongodb");
  compose("up", "-d", "--wait", "mongodb");

  prisma = new PrismaClient({ datasourceUrl: testUrl });
  const found = await prisma.order.findUnique({ where: { id: created.id } });
  assert.ok(found, "order should still exist after the restart");
  assert.equal(found.title, title);
  assert.equal(found.status, created.status);
  assert.equal(found.version, created.version);
  assert.equal(found.createdAt.toISOString(), created.createdAt.toISOString());
  console.log(`read back after restart: ${found.id} (${found.status}, version ${found.version})`);
} catch (error) {
  process.exitCode = 1;
  console.error("persistence check failed:", error);
} finally {
  try {
    // Make sure the database is running again before cleaning up.
    compose("up", "-d", "--wait", "mongodb");
    // Delete only the record this check created, by id.
    if (createdId) {
      const { count } = await prisma.order.deleteMany({ where: { id: createdId } });
      const remaining = await prisma.order.count({ where: { id: createdId } });
      console.log(`cleanup: deleted ${count}, remaining ${remaining}`);
      if (remaining !== 0) process.exitCode = 1;
    }
  } catch (error) {
    process.exitCode = 1;
    console.error("cleanup failed:", error);
  }
  await prisma.$disconnect();
}

console.log(process.exitCode ? "FAIL" : "PASS");
