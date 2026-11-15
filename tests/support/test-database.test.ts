import { describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./test-database.mts";

const DEV = "mongodb://127.0.0.1:27017/signflow?replicaSet=rs0";

describe("assertSafeTestDatabase", () => {
  it("accepts an explicit *_test database that differs from development", () => {
    expect(assertSafeTestDatabase("mongodb://127.0.0.1:27017/signflow_test?replicaSet=rs0", DEV)).toBe(
      "signflow_test",
    );
  });

  it("refuses when the test URL is missing", () => {
    expect(() => assertSafeTestDatabase(undefined, DEV)).toThrow(/not set/);
    expect(() => assertSafeTestDatabase("", DEV)).toThrow(/not set/);
  });

  it("refuses the development database itself", () => {
    expect(() => assertSafeTestDatabase(DEV, DEV)).toThrow(/not an explicit test database/);
  });

  it("refuses a test URL with the same database name as development", () => {
    expect(() =>
      assertSafeTestDatabase(
        "mongodb://localhost:27017/signflow_test",
        "mongodb://127.0.0.1:27018/signflow_test",
      ),
    ).toThrow(/development database/);
  });

  it.each([
    "mongodb://127.0.0.1:27017/signflow",
    "mongodb://127.0.0.1:27017/signflow_testing",
    "mongodb://127.0.0.1:27017/test",
    "mongodb://127.0.0.1:27017/",
    "mongodb://127.0.0.1:27017",
    "postgres://127.0.0.1/signflow_test",
  ])("refuses %s", (url) => {
    expect(() => assertSafeTestDatabase(url, DEV)).toThrow();
  });
});
