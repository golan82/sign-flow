// Upload rules shared by the UI and the server. No server-only imports.

const GIB = 1024 ** 3;

/**
 * Largest accepted file. The task mentions "1GB+" print files; 5 GiB is the
 * single-request (non-multipart) limit of common object stores such as S3,
 * which is what one pre-signed PUT URL can carry.
 */
export const MAX_UPLOAD_BYTES = 5 * GIB;

/** How long a signed upload URL stays valid. */
export const UPLOAD_AUTHORIZATION_TTL_MS = 30 * 60 * 1000;

export const MAX_FILE_NAME_LENGTH = 200;

/** Print file formats accepted, with the file extensions allowed for each. */
export const ALLOWED_UPLOAD_TYPES = {
  "application/pdf": ["pdf"],
  "image/tiff": ["tif", "tiff"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/svg+xml": ["svg"],
  "application/postscript": ["eps", "ai"],
  "image/vnd.adobe.photoshop": ["psd"],
} as const satisfies Record<string, readonly string[]>;

export type UploadContentType = keyof typeof ALLOWED_UPLOAD_TYPES;
export const UPLOAD_CONTENT_TYPES = Object.keys(ALLOWED_UPLOAD_TYPES) as [
  UploadContentType,
  ...UploadContentType[],
];

export const ACCEPT_ATTRIBUTE = Object.values(ALLOWED_UPLOAD_TYPES)
  .flat()
  .map((extension) => `.${extension}`)
  .join(",");

export function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

/** Content type for a file name, for files the browser reports without one. */
export function contentTypeForFileName(fileName: string): UploadContentType | null {
  const extension = getExtension(fileName);
  for (const type of UPLOAD_CONTENT_TYPES) {
    if ((ALLOWED_UPLOAD_TYPES[type] as readonly string[]).includes(extension)) return type;
  }
  return null;
}

/** Origin of the simulated object store. ".invalid" is reserved and never resolves. */
export const SIMULATED_STORAGE_ORIGIN = "https://simulated-storage.invalid";

/** Upload statuses, mirroring the Prisma enum. */
export const UPLOAD_STATUSES = ["PENDING_UPLOAD", "COMPLETED", "CANCELLED", "FAILED"] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}
