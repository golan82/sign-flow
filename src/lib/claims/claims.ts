// Claim model shared by the UI and the server. No server-only imports.

export const CLAIM_STATES = ["NONE", "PENDING_VERIFICATION", "CONFIRMED"] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

/** Public view of a claim. The claim token is never part of it. */
export type ClaimDto = {
  state: ClaimState;
  installerId: string | null;
  expiresAt: string | null;
  claimedAt: string | null;
  confirmedAt: string | null;
};

export const NO_CLAIM: ClaimDto = {
  state: "NONE",
  installerId: null,
  expiresAt: null,
  claimedAt: null,
  confirmedAt: null,
};

/**
 * What a viewer should see at `nowMs` (server-clock milliseconds). A pending
 * claim whose expiry has passed is EXPIRED, and therefore claimable, even if
 * the expiry worker has not released it yet.
 */
export type EffectiveClaimState = "AVAILABLE" | "PENDING" | "EXPIRED" | "CONFIRMED";

export function getEffectiveClaimState(claim: ClaimDto, nowMs: number): EffectiveClaimState {
  switch (claim.state) {
    case "NONE":
      return "AVAILABLE";
    case "CONFIRMED":
      return "CONFIRMED";
    case "PENDING_VERIFICATION":
      return getClaimRemainingMs(claim, nowMs) > 0 ? "PENDING" : "EXPIRED";
  }
}

/**
 * Identifies the claim a viewer sees at `nowMs`: its effective state, installer
 * and claim time. The countdown does not change it; expiry, release, a new
 * claim or confirmation do. A local message about a claim outcome is shown
 * only while this key still matches the latest order data.
 */
export function getClaimViewKey(claim: ClaimDto, nowMs: number): string {
  return [getEffectiveClaimState(claim, nowMs), claim.installerId ?? "", claim.claimedAt ?? ""].join("|");
}

export function getClaimRemainingMs(claim: ClaimDto, nowMs: number): number {
  if (claim.state !== "PENDING_VERIFICATION" || !claim.expiresAt) return 0;
  return Math.max(0, Date.parse(claim.expiresAt) - nowMs);
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
