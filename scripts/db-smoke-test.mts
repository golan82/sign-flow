// Focused integration check against the local MongoDB replica set (test
// database from TEST_DATABASE_URL): create one test order, read it back, and
// always delete only that order.
// Run with: npm run test:db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// @prisma/client is CommonJS with re-exported members that Node's ESM loader
// cannot detect as named exports, so import the default and destructure.
import prismaClient from "@prisma/client";

import { assertSafeTestDatabase } from "../tests/support/test-database.mts";

const testUrl = process.env.TEST_DATABASE_URL;
assertSafeTestDatabase(testUrl, process.env.DATABASE_URL);

const { PrismaClient } = prismaClient;
const prisma = new PrismaClient({ datasourceUrl: testUrl });
const title = `db-smoke-test ${randomUUID()}`;
let createdId: string | undefined;

try {
  const hello = await prisma.$runCommandRaw({ hello: 1 });
  assert.equal(hello.setName, "rs0", "expected to be connected to replica set rs0");
  assert.equal(hello.isWritablePrimary, true, "expected to be connected to the PRIMARY");
  console.log(`connected: set=${hello.setName} primary=${hello.primary}`);

  const created = await prisma.order.create({ data: { title } });
  createdId = created.id;
  assert.match(created.id, /^[0-9a-f]{24}$/, "id should be an ObjectId hex string");
  console.log(`created: ${created.id}`);

  const found = await prisma.order.findUnique({ where: { id: created.id } });
  assert.ok(found, "created order should be readable");
  assert.equal(found.title, title);
  assert.ok(found.createdAt instanceof Date && found.updatedAt instanceof Date);
  console.log("read back: ok");
} catch (error) {
  process.exitCode = 1;
  console.error("db smoke test failed:", error);
} finally {
  // Delete only the record this check created, by id.
  try {
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
