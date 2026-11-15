import { CloudUpload, Paperclip } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/uploads/constants";
import type { UploadDto } from "@/lib/uploads/types";

import { isActivePhase, type LocalUpload } from "./use-upload-manager";

/**
 * Upload line for an order row: live local progress for this tab's upload,
 * otherwise the persisted metadata (as every tab sees it via SSE).
 */
export function UploadSummary({
  uploads,
  local,
  serverNow,
}: {
  uploads: UploadDto[];
  local: LocalUpload | undefined;
  serverNow: number;
}) {
  if (local && isActivePhase(local.phase)) {
    const percent = Math.floor((local.loadedBytes / local.file.sizeBytes) * 100);
    return (
      <div className="grid max-w-xs gap-1" data-row-upload="local">
        <p className="flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-300">
          <CloudUpload aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">
            Uploading {local.file.name} · {percent}% of {formatBytes(local.file.sizeBytes)}
          </span>
        </p>
        <Progress value={percent} aria-label={`Upload progress for ${local.file.name}`} />
      </div>
    );
  }

  const completed = uploads.filter((upload) => upload.status === "COMPLETED");
  const inProgress = uploads.filter(
    (upload) => upload.status === "PENDING_UPLOAD" && Date.parse(upload.expiresAt) > serverNow,
  );
  if (completed.length === 0 && inProgress.length === 0) return null;

  const parts = [];
  if (completed.length > 0) {
    parts.push(
      completed.length === 1
        ? `${completed[0].originalName} (${formatBytes(completed[0].sizeBytes)}) uploaded`
        : `${completed.length} print files uploaded`,
    );
  }
  if (inProgress.length > 0) {
    parts.push(`${inProgress.length} upload${inProgress.length > 1 ? "s" : ""} in progress`);
  }
  return (
    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-row-upload="server">
      <Paperclip aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{parts.join(" · ")}</span>
    </p>
  );
}
