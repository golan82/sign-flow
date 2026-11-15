import "server-only";

import { PrismaClient } from "@prisma/client";

// Reuse one client across hot reloads in development; module state is reset
// on every reload, globalThis is not.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
