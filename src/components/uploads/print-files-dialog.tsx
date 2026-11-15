"use client";

import { useId, useState, type ChangeEvent } from "react";
import { CloudUpload, FileText, FlaskConical } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { MAX_UPLOAD_ATTEMPTS_PER_ORDER } from "@/lib/demo-limits.mts";
import { isTerminalStatus } from "@/lib/orders/status";
import type { OrderDto } from "@/lib/orders/types";
import {
  ACCEPT_ATTRIBUTE,
  contentTypeForFileName,
  formatBytes,
  MAX_UPLOAD_BYTES,
  UPLOAD_CONTENT_TYPES,
  type UploadContentType,
} from "@/lib/uploads/constants";
import type { UploadDto } from "@/lib/uploads/types";
import { cn } from "@/lib/utils";

import { isActivePhase, type FileDescriptor, type LocalUpload, type UploadPhase } from "./use-upload-manager";

/** A 1.5 GB print file for demos. Only metadata: no content is created or read. */
export const DEMO_PRINT_FILE: FileDescriptor = {
  name: "storefront-banner-print-demo.pdf",
  sizeBytes: Math.round(1.5 * 1024 ** 3),
  contentType: "application/pdf",
  isDemo: true,
};

const PHASE_TEXT: Record<UploadPhase, string> = {
  authorizing: "Requesting a signed upload URL…",
  uploading: "Uploading to simulated storage…",
  completing: "Confirming the upload with the server…",
  completed: "Upload complete (simulated)",
  failed: "Upload failed",
  cancelled: "Upload cancelled",
  expired: "Upload authorization expired",
  error: "Upload could not be completed",
};

/** Status of server-side upload metadata, as other tabs see it. */
export function describeUpload(upload: UploadDto, serverNow: number, local: boolean) {
  if (upload.status === "PENDING_UPLOAD") {
    if (Date.parse(upload.expiresAt) <= serverNow) return { label: "Authorization expired", tone: "muted" };
    return { label: local ? "Uploading in this tab" : "Upload in progress (another tab)", tone: "active" };
  }
  return {
    COMPLETED: { label: "Uploaded (simulated)", tone: "done" },
    CANCELLED: { label: "Cancelled", tone: "muted" },
    FAILED: { label: "Failed", tone: "error" },
  }[upload.status];
}

function descriptorFor(file: File): FileDescriptor | string {
  const reported = (UPLOAD_CONTENT_TYPES as readonly string[]).includes(file.type)
    ? (file.type as UploadContentType)
    : null;
  // Some print formats (.ai, .eps, .psd) are often reported without a type.
  const contentType = reported ?? contentTypeForFileName(file.name);
  if (!contentType) return "Unsupported file type. Use PDF, TIFF, PNG, JPEG, SVG, EPS/AI or PSD.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return "The file is larger than 5 GB.";
  // Only metadata is taken from the File; its content is never read.
  return { name: file.name, sizeBytes: file.size, contentType, isDemo: false };
}

export function PrintFilesDialog({
  order,
  local,
  serverNow,
  onStart,
  onCancel,
}: {
  order: OrderDto;
  local: LocalUpload | undefined;
  serverNow: number;
  onStart: (file: FileDescriptor, simulateFailure: boolean) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<FileDescriptor | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const inputId = useId();
  const failureId = useId();
  const limitId = useId();

  const active = local !== undefined && isActivePhase(local.phase);
  const finished = local !== undefined && !active;
  const canUpload = !isTerminalStatus(order.status);
  // Every attempt is listed and counts, so the list shows when the demo limit
  // is reached. The server enforces it either way (409 DEMO_LIMIT_REACHED).
  const attemptLimitReached = order.uploads.length >= MAX_UPLOAD_ATTEMPTS_PER_ORDER;
  const percent = local ? Math.floor((local.loadedBytes / local.file.sizeBytes) * 100) : 0;

  function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const result = descriptorFor(file);
    if (typeof result === "string") {
      setSelected(null);
      setSelectionError(result);
    } else {
      setSelected(result);
      setSelectionError(null);
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Print files<span className="sr-only">: {order.title}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Print files</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{order.title}</span>
          </DialogDescription>
        </DialogHeader>

        <Alert className="border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40">
          <FlaskConical aria-hidden="true" />
          <AlertDescription className="text-current">
            <strong>Simulated upload.</strong> No file bytes leave this browser: the signed URL
            points to a simulated store (<code>simulated-storage.invalid</code>) and the progress
            is simulated. Only file metadata is saved.
          </AlertDescription>
        </Alert>

        {/* grid-cols-[minmax(0,1fr)] on every grid here: an auto column grows to the
            full width of a truncated file name and pushes content out of the dialog. */}
        {canUpload && !active && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
              <Label htmlFor={inputId}>Print file</Label>
              <input
                id={inputId}
                type="file"
                accept={ACCEPT_ATTRIBUTE}
                onChange={onFileChosen}
                className="w-full min-w-0 text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium"
              />
              <p className="text-xs text-muted-foreground">PDF, TIFF, PNG, JPEG, SVG, EPS/AI or PSD, up to 5 GB.</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="justify-self-start"
                onClick={() => {
                  setSelected(DEMO_PRINT_FILE);
                  setSelectionError(null);
                }}
              >
                Use a 1.5 GB demo print file
              </Button>
            </div>

            {selectionError && (
              <p role="alert" className="text-sm text-destructive">
                {selectionError}
              </p>
            )}

            {selected && (
              <div className="flex items-center gap-2 rounded-lg border p-3 text-sm" data-testid="selected-file">
                <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium" title={selected.name}>
                  {selected.name}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(selected.sizeBytes)}</span>
                {selected.isDemo && <Badge variant="outline">Demo · no content</Badge>}
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                id={failureId}
                type="checkbox"
                checked={simulateFailure}
                onChange={(event) => setSimulateFailure(event.target.checked)}
                className="size-4 accent-primary"
              />
              <Label htmlFor={failureId} className="font-normal">
                Simulate a network failure at 40% (demo)
              </Label>
            </div>

            {attemptLimitReached && (
              <p id={limitId} className="text-sm text-muted-foreground" data-testid="upload-limit">
                This order has reached the demo limit of {MAX_UPLOAD_ATTEMPTS_PER_ORDER} upload
                attempts (failed and cancelled ones included).
              </p>
            )}

            <Button
              disabled={!selected || attemptLimitReached}
              aria-describedby={attemptLimitReached ? limitId : undefined}
              onClick={() => selected && onStart(selected, simulateFailure)}
            >
              <CloudUpload aria-hidden="true" />
              {finished ? "Upload another file" : "Start upload"}
            </Button>
          </div>
        )}

        {!canUpload && (
          <p className="text-sm text-muted-foreground">
            New uploads cannot be started for a completed or cancelled order.
          </p>
        )}

        {local && (
          <section aria-label="Current upload" className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border p-3 text-sm" data-upload-phase={local.phase}>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium" title={local.file.name}>
                {local.file.name}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatBytes(local.loadedBytes)} / {formatBytes(local.file.sizeBytes)}
              </span>
            </div>
            <Progress value={percent} aria-label={`Upload progress for ${local.file.name}`} />
            <p
              role={local.phase === "failed" || local.phase === "error" || local.phase === "expired" ? "alert" : "status"}
              className={cn(
                local.phase === "completed" && "text-emerald-700 dark:text-emerald-300",
                (local.phase === "failed" || local.phase === "error" || local.phase === "expired") && "text-destructive",
              )}
            >
              {PHASE_TEXT[local.phase]}
              {local.phase === "uploading" ? ` · ${percent}%` : ""}
              {local.message && local.phase !== "completed" ? ` — ${local.message}` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {local.phase === "uploading" && (
                <Button variant="outline" size="sm" onClick={onCancel}>
                  Cancel upload
                </Button>
              )}
              {canUpload && ["failed", "cancelled", "expired", "error"].includes(local.phase) && (
                <Button size="sm" onClick={() => onStart(local.file, simulateFailure)}>
                  Try again
                </Button>
              )}
            </div>
          </section>
        )}

        <section aria-label="Files on this order" className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <h3 className="text-sm font-medium">Files on this order</h3>
          {order.uploads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No files yet.</p>
          ) : (
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-1.5 text-sm">
              {order.uploads.map((upload) => {
                const status = describeUpload(upload, serverNow, upload.id === local?.uploadId && active);
                return (
                  <li key={upload.id} className="flex items-center gap-2" data-upload-status={upload.status}>
                    <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate" title={upload.originalName}>
                      {upload.originalName}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(upload.sizeBytes)}</span>
                    <UploadStatusText {...status} />
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Files are not downloadable here: no real bytes are stored in this simulation.
          </p>
        </section>

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

export function UploadStatusText({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      className={cn(
        "shrink-0 text-xs font-medium",
        tone === "done" && "text-emerald-700 dark:text-emerald-300",
        tone === "active" && "text-sky-700 dark:text-sky-300",
        tone === "error" && "text-destructive",
        tone === "muted" && "text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}
