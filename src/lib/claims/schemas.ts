// Request payload schemas for the claim API. No server-only imports.
import { z } from "zod";

import { DEMO_INSTALLER_IDS } from "./installers";

const installerIdSchema = z.enum(DEMO_INSTALLER_IDS, {
  error: "installerId must be one of the demo installers",
});

export const claimRequestSchema = z.strictObject({
  installerId: installerIdSchema,
});

export const VERIFICATION_OUTCOMES = ["PASSED", "FAILED"] as const;

export const verificationRequestSchema = z.strictObject({
  installerId: installerIdSchema,
  // 32 random bytes, base64url-encoded by the server.
  claimToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "claimToken is malformed"),
  // Simulated identity/payment verification result.
  outcome: z.enum(VERIFICATION_OUTCOMES),
});

export type ClaimRequest = z.infer<typeof claimRequestSchema>;
export type VerificationRequest = z.infer<typeof verificationRequestSchema>;
