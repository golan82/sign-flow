// Claim constants shared by the UI, the API and the expiry worker.
// No imports: the worker loads this file directly with Node.

/** A PENDING_VERIFICATION claim lapses this long after it was made. */
export const CLAIM_TTL_MS = 180_000;

/** Only orders in this status can be claimed by an installer. */
export const CLAIMABLE_STATUS = "READY_FOR_INSTALL";
