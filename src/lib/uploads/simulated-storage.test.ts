import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIMULATED_STORAGE_ORIGIN } from "./constants";
import { createSimulatedStorageAdapter, SimulatedUploadError, type UploadProgress } from "./simulated-storage";

const GIB = 1024 ** 3;
const urlFor = (size: number) => `${SIMULATED_STORAGE_ORIGIN}/orders/a/b/c.pdf?X-Size=${size}&X-Signature=x`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("simulated storage adapter", () => {
  it("simulates a 5 GiB upload with monotonic progress and no content in memory", async () => {
    const size = 5 * GIB;
    const before = process.memoryUsage().arrayBuffers;
    const progress: UploadProgress[] = [];
    const adapter = createSimulatedStorageAdapter({ bytesPerSecond: GIB, tickMs: 100 });

    const done = adapter.upload(
      { uploadUrl: urlFor(size), sizeBytes: size },
      { signal: new AbortController().signal, onProgress: (p) => progress.push(p) },
    );
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();

    expect(progress[0]).toEqual({ loadedBytes: 0, totalBytes: size });
    expect(progress.at(-1)).toEqual({ loadedBytes: size, totalBytes: size });
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].loadedBytes).toBeGreaterThan(progress[i - 1].loadedBytes);
    }
    expect(progress.length).toBe(51); // initial 0 + 5 s / 100 ms ticks
    // Nothing near the file size was allocated.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
  });

  it("follows elapsed time even when timer ticks are delayed (throttled background tab)", async () => {
    const adapter = createSimulatedStorageAdapter({ bytesPerSecond: GIB, tickMs: 100 });
    const progress: number[] = [];
    const done = adapter.upload(
      { uploadUrl: urlFor(4 * GIB), sizeBytes: 4 * GIB },
      { signal: new AbortController().signal, onProgress: (p) => progress.push(p.loadedBytes) },
    );
    // The clock moves 3 s while no tick runs, then one tick fires.
    vi.setSystemTime(Date.now() + 3_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(progress.at(-1)).toBe(Math.floor(3.1 * GIB));
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();
  });

  it("stops and rejects with AbortError when cancelled", async () => {
    const controller = new AbortController();
    const adapter = createSimulatedStorageAdapter({ bytesPerSecond: GIB, tickMs: 100 });
    let last = 0;
    const done = adapter.upload(
      { uploadUrl: urlFor(GIB), sizeBytes: GIB },
      { signal: controller.signal, onProgress: (p) => (last = p.loadedBytes) },
    );
    const assertion = expect(done).rejects.toMatchObject({ name: "AbortError" });

    await vi.advanceTimersByTimeAsync(300);
    controller.abort();
    const atAbort = last;
    await vi.advanceTimersByTimeAsync(5_000);

    await assertion;
    expect(atAbort).toBeGreaterThan(0);
    expect(last).toBe(atAbort); // no progress after cancel
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can simulate a network failure part-way", async () => {
    const adapter = createSimulatedStorageAdapter({ bytesPerSecond: GIB, tickMs: 100, failAtFraction: 0.4 });
    let last = 0;
    const done = adapter.upload(
      { uploadUrl: urlFor(GIB), sizeBytes: GIB },
      { signal: new AbortController().signal, onProgress: (p) => (last = p.loadedBytes) },
    );
    const assertion = expect(done).rejects.toBeInstanceOf(SimulatedUploadError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(last).toBe(Math.floor(GIB * 0.4));
  });

  it("refuses URLs for another store or another size", async () => {
    const adapter = createSimulatedStorageAdapter();
    const signal = new AbortController().signal;
    const onProgress = () => {};
    await expect(
      adapter.upload({ uploadUrl: "https://s3.example.com/x?X-Size=10", sizeBytes: 10 }, { signal, onProgress }),
    ).rejects.toThrow(/rejected/);
    await expect(adapter.upload({ uploadUrl: urlFor(10), sizeBytes: 11 }, { signal, onProgress })).rejects.toThrow(
      /rejected/,
    );
  });
});
