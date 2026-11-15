// Guard used by every test runner that writes to MongoDB (Vitest integration
// tests and the scripts/*.mts DB checks). It refuses to run unless the test
// database is explicit and cannot be the development database.
// Plain .mts without app imports so Node can load it directly.

const TEST_DB_NAME = /^[A-Za-z0-9_-]+_test$/;

type ParsedMongoUrl = { hosts: string; database: string };

function parseMongoUrl(url: string, label: string): ParsedMongoUrl {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?#]+)\/([^?#]*)/.exec(url);
  if (!match) {
    throw new Error(`${label} is not a mongodb:// URL with a database name`);
  }
  const hosts = match[1]
    .toLowerCase()
    .split(",")
    .map((host) => host.replace(/^localhost(?=:|$)/, "127.0.0.1"))
    .sort()
    .join(",");
  return { hosts, database: decodeURIComponent(match[2]) };
}

/**
 * Throws unless `testUrl` names an explicit test database (name ends in
 * "_test") that is not the development database from `devUrl`.
 * Returns the test database name.
 */
export function assertSafeTestDatabase(
  testUrl: string | undefined,
  devUrl: string | undefined,
): string {
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is not set; refusing to run database tests.");
  }
  const test = parseMongoUrl(testUrl, "TEST_DATABASE_URL");
  if (!TEST_DB_NAME.test(test.database)) {
    throw new Error(
      `Test database "${test.database}" is not an explicit test database (name must end in "_test").`,
    );
  }
  if (devUrl) {
    const dev = parseMongoUrl(devUrl, "DATABASE_URL");
    if (dev.database === test.database) {
      throw new Error(
        `TEST_DATABASE_URL points at the development database "${dev.database}"; refusing to run.`,
      );
    }
  }
  return test.database;
}
