"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  abortUploadRequest,
  authorizeUploadRequest,
  completeUploadRequest,
} from "@/lib/orders/api-client";
import type { UploadContentType } from "@/lib/uploads/constants";
import type { AbortReason } from "@/lib/uploads/schemas";
import { createSimulatedStorageAdapter } from "@/lib/uploads/simulated-storage";

/** What the user picked: a real file's metadata, or the demo file (no content at all). */
export type FileDescriptor = {
  name: string;
  sizeBytes: number;
  contentType: UploadContentType;
  isDemo: boolean;
};

export type UploadPhase =
  | "authorizing"
  | "uploading"
  | "completing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "error";

/** This tab's current upload attempt for an order (progress is never sent to the server). */
export type LocalUpload = {
  orderId: string;
  file: FileDescriptor;
  simulateFailure: boolean;
  uploadId: string | null;
  phase: UploadPhase;
  loadedBytes: number;
  message: string | null;
};

const ACTIVE_PHASES: UploadPhase[] = ["authorizing", "uploading", "completing"];
export const isActivePhase = (phase: UploadPhase) => ACTIVE_PHASES.includes(phase);

/**
 * Runs uploads for this tab: authorize -> simulated direct upload with local
 * progress -> complete (or abort). One attempt per order at a time; a second
 * start while one is running is ignored, and every attempt has its own
 * clientRequestId so the server never creates duplicates for one click.
 */
export function useUploadManager() {
  const [uploads, setUploads] = useState<Record<string, LocalUpload>>({});
  const busy = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());

  // Stop simulated transfers when the dashboard unmounts.
  useEffect(() => {
    const running = controllers.current;
    return () => {
      for (const controller of running.values()) controller.abort();
    };
  }, []);

  const update = useCallback((orderId: string, patch: Partial<LocalUpload>) => {
    setUploads((current) =>
      current[orderId] ? { ...current, [orderId]: { ...current[orderId], ...patch } } : current,
    );
  }, []);

  const start = useCallback(
    async (orderId: string, file: FileDescriptor, simulateFailure: boolean) => {
      if (busy.current.has(orderId)) return; // double click
      busy.current.add(orderId);
      setUploads((current) => ({
        ...current,
        [orderId]: { orderId, file, simulateFailure, uploadId: null, phase: "authorizing", loadedBytes: 0, message: null },
      }));
      try {
        const authorized = await authorizeUploadRequest(orderId, {
          clientRequestId: crypto.randomUUID(),
          originalName: file.name,
          sizeBytes: file.sizeBytes,
          contentType: file.contentType,
        });
        if (!authorized.ok) {
          update(orderId, { phase: "error", message: authorized.error.message });
          return;
        }
        const { upload, uploadUrl } = authorized.data;
        update(orderId, { uploadId: upload.id, phase: "uploading" });

        const controller = new AbortController();
        controllers.current.set(orderId, controller);
        const adapter = createSimulatedStorageAdapter({ failAtFraction: simulateFailure ? 0.4 : undefined });
        try {
          await adapter.upload(
            { uploadUrl, sizeBytes: file.sizeBytes },
            { signal: controller.signal, onProgress: (p) => update(orderId, { loadedBytes: p.loadedBytes }) },
          );
        } catch (error) {
          const reason: AbortReason =
            error instanceof DOMException && error.name === "AbortError" ? "CANCELLED" : "FAILED";
          const aborted = await abortUploadRequest(orderId, upload.id, uploadUrl, reason);
          update(
            orderId,
            aborted.ok
              ? {
                  phase: reason === "CANCELLED" ? "cancelled" : "failed",
                  message:
                    reason === "CANCELLED"
                      ? "Upload cancelled. Nothing was stored."
                      : "The (simulated) connection dropped. The attempt was marked as failed — try again.",
                }
              : { phase: "error", message: aborted.error.message },
          );
          return;
        } finally {
          controllers.current.delete(orderId);
        }

        update(orderId, { phase: "completing" });
        const completed = await completeUploadRequest(orderId, upload.id, uploadUrl);
        if (completed.ok) {
          update(orderId, { phase: "completed", message: "Upload complete (simulated)." });
        } else if (completed.error.code === "UPLOAD_EXPIRED") {
          update(orderId, { phase: "expired", message: completed.error.message });
        } else {
          update(orderId, { phase: "error", message: completed.error.message });
        }
      } finally {
        busy.current.delete(orderId);
      }
    },
    [update],
  );

  const cancel = useCallback((orderId: string) => {
    controllers.current.get(orderId)?.abort();
  }, []);

  return { uploads, start, cancel };
}
