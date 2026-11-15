// SIMULATED direct-to-storage upload, run in the browser.
//
// Nothing is sent over the network and no file content is read: the adapter
// only receives the signed URL and the size, and advances a progress counter
// on a timer. It stands in for a real adapter that would PUT the file to the
// pre-signed URL (e.g. with XMLHttpRequest for upload progress); swapping it
// means implementing DirectUploadAdapter, nothing else.
import { SIMULATED_STORAGE_ORIGIN } from "./constants";

export type UploadProgress = { loadedBytes: number; totalBytes: number };

export type DirectUploadTarget = { uploadUrl: string; sizeBytes: number };

export type DirectUploadOptions = {
  signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void;
};

/** Contract for sending one file to object storage with a pre-signed URL. */
export interface DirectUploadAdapter {
  upload(target: DirectUploadTarget, options: DirectUploadOptions): Promise<void>;
}

export class SimulatedUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulatedUploadError";
  }
}

export const SIMULATED_BYTES_PER_SECOND = 96 * 1024 * 1024;

export function createSimulatedStorageAdapter(
  options: {
    bytesPerSecond?: number;
    tickMs?: number;
    /** Demo: fail after this fraction (0–1) of the bytes, like a dropped connection. */
    failAtFraction?: number;
  } = {},
): DirectUploadAdapter {
  const bytesPerSecond = options.bytesPerSecond ?? SIMULATED_BYTES_PER_SECOND;
  const tickMs = options.tickMs ?? 100;

  return {
    upload({ uploadUrl, sizeBytes }, { signal, onProgress }) {
      return new Promise<void>((resolve, reject) => {
        // Like a real store, refuse a URL that is not for this store or this size.
        let url: URL;
        try {
          url = new URL(uploadUrl);
        } catch {
          return reject(new SimulatedUploadError("Invalid upload URL"));
        }
        if (url.origin !== SIMULATED_STORAGE_ORIGIN || Number(url.searchParams.get("X-Size")) !== sizeBytes) {
          return reject(new SimulatedUploadError("The storage rejected the upload URL"));
        }

        const failAt =
          options.failAtFraction === undefined ? Infinity : Math.floor(sizeBytes * options.failAtFraction);
        let loaded = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException("Upload cancelled", "AbortError"));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });

        // Progress follows elapsed time, not the number of timer ticks, so a
        // throttled background tab does not slow the "transfer" down.
        const startedAt = Date.now();
        const step = () => {
          const elapsedMs = Date.now() - startedAt;
          loaded = Math.max(loaded, Math.min(sizeBytes, Math.floor((elapsedMs * bytesPerSecond) / 1000)));
          if (loaded >= failAt) {
            signal.removeEventListener("abort", onAbort);
            onProgress({ loadedBytes: failAt, totalBytes: sizeBytes });
            return reject(new SimulatedUploadError("Simulated network failure"));
          }
          onProgress({ loadedBytes: loaded, totalBytes: sizeBytes });
          if (loaded >= sizeBytes) {
            signal.removeEventListener("abort", onAbort);
            return resolve();
          }
          timer = setTimeout(step, tickMs);
        };
        onProgress({ loadedBytes: 0, totalBytes: sizeBytes });
        timer = setTimeout(step, tickMs);
      });
    },
  };
}
