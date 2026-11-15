// Runs before every integration test file (vitest.config.mts). Throws, and so
// stops the file before any write, unless DATABASE_URL is a safe test database.
import { assertSafeTestDatabase } from "../support/test-database.mts";

assertSafeTestDatabase(process.env.DATABASE_URL, process.env.DEV_DATABASE_URL);
