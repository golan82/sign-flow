"use client";

import { useRef, useState } from "react";
import { FlaskConical } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  formatCountdown,
  getClaimRemainingMs,
  getClaimViewKey,
  getEffectiveClaimState,
} from "@/lib/claims/claims";
import { CLAIM_TTL_MS, CLAIMABLE_STATUS } from "@/lib/claims/constants.mts";
import type { HeldClaim } from "@/lib/claims/held-claims";
import { getInstallerName, type DemoInstallerId } from "@/lib/claims/installers";
import { claimRequest, verificationRequest } from "@/lib/orders/api-client";
import type { OrderDto } from "@/lib/orders/types";

/**
 * A local outcome message. With `claimKey` it describes that claim (see
 * getClaimViewKey) and is hidden once the latest order data shows a different
 * one; without it, it reports an attempt in past tense and stays until the next
 * action or the dialog is reopened.
 */
type Message = { tone: "success" | "error"; text: string; claimKey?: string };

const CLAIM_MINUTES = CLAIM_TTL_MS / 60_000;

export function InstallerAssignmentDialog({
  order,
  actingInstallerId,
  heldClaim,
  serverNow,
  onClaimed,
  onVerifying,
  onClaimFinished,
  onChanged,
}: {
  order: OrderDto;
  actingInstallerId: DemoInstallerId;
  /** This tab's token for the order's current claim, if it holds one. */
  heldClaim: HeldClaim | undefined;
  serverNow: number;
  onClaimed: (order: OrderDto, claim: HeldClaim) => void;
  /** A verification result for the held claim was sent (true) or answered (false). */
  onVerifying: (orderId: string, verifying: boolean) => void;
  onClaimFinished: (orderId: string) => void;
  /** Called after any server response that may have changed the order. */
  onChanged: (order?: OrderDto) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<"claim" | "PASSED" | "FAILED" | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const pendingRef = useRef(false);

  const { claim } = order;
  const effective = getEffectiveClaimState(claim, serverNow);
  const claimerName = getInstallerName(claim.installerId);
  const actingName = getInstallerName(actingInstallerId);
  const claimable = order.status === CLAIMABLE_STATUS;
  const canClaim = claimable && (effective === "AVAILABLE" || effective === "EXPIRED");
  const activeHeldClaim = effective === "PENDING" ? heldClaim : undefined;
  const holdsActiveClaim = activeHeldClaim !== undefined;
  const heldClaimExpired = effective === "EXPIRED" && heldClaim !== undefined;
  const visibleMessage =
    message && (message.claimKey === undefined || message.claimKey === getClaimViewKey(claim, serverNow))
      ? message
      : null;

  function handleOpenChange(next: boolean) {
    if (pendingRef.current) return;
    setOpen(next);
    if (next) setMessage(null);
  }

  async function run(action: "claim" | "PASSED" | "FAILED") {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(action);
    setMessage(null);
    try {
      if (action === "claim") {
        const result = await claimRequest(order.id, { installerId: actingInstallerId });
        if (result.ok) {
          const { order: claimed, claimToken } = result.data;
          onClaimed(claimed, {
            orderId: claimed.id,
            installerId: actingInstallerId,
            token: claimToken,
            claimedAt: claimed.claim.claimedAt!,
          });
          setMessage({
            tone: "success",
            text: `Claimed as ${actingName}. Complete verification within ${CLAIM_MINUTES} minutes or the job returns to the marketplace.`,
            claimKey: getClaimViewKey(claimed.claim, serverNow),
          });
        } else if (result.status === 409) {
          setMessage({ tone: "error", text: "Another installer claimed this job first." });
        } else {
          setMessage({ tone: "error", text: result.error.message });
        }
        onChanged();
        return;
      }

      if (!activeHeldClaim) return;
      onVerifying(order.id, true);
      let result;
      try {
        result = await verificationRequest(order.id, {
          installerId: actingInstallerId,
          claimToken: activeHeldClaim.token,
          outcome: action,
        });
      } finally {
        // No-op when the claim was already forgotten (live update or onClaimFinished).
        onVerifying(order.id, false);
      }
      if (result.ok) {
        onClaimFinished(order.id);
        onChanged(result.data.order);
        const claimKey = getClaimViewKey(result.data.order.claim, serverNow);
        setMessage(
          action === "PASSED"
            ? { tone: "success", text: `Verification passed. ${actingName} is assigned to this job.`, claimKey }
            : { tone: "error", text: "Verification failed, so your claim was released.", claimKey },
        );
        return;
      }
      if (result.error.code === "CLAIM_EXPIRED" || result.error.code === "CLAIM_NOT_ACTIVE") {
        onClaimFinished(order.id);
      }
      setMessage({ tone: "error", text: result.error.message });
      onChanged();
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Installer assignment<span className="sr-only">: {order.title}</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Installer assignment</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{order.title}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 text-sm" aria-live="polite">
          {!claimable ? (
            <p>This order is no longer ready for install, so it cannot be claimed.</p>
          ) : effective === "AVAILABLE" ? (
            <p>
              This job is open. Claiming it reserves it for you for {CLAIM_MINUTES} minutes while
              identity and payment are verified.
            </p>
          ) : effective === "EXPIRED" ? (
            <p>
              {heldClaimExpired ? "Your" : `${claimerName}'s`} claim expired before verification, so
              the job is open again.
            </p>
          ) : effective === "PENDING" ? (
            <p>
              Claimed by <strong>{claimerName}</strong>
              {holdsActiveClaim ? " (this tab)" : ""}. Awaiting identity and payment verification —{" "}
              <strong className="tabular-nums">
                {formatCountdown(getClaimRemainingMs(claim, serverNow))}
              </strong>{" "}
              left.
            </p>
          ) : (
            <p>
              Assigned to <strong>{claimerName}</strong>. Verification passed, so this assignment
              no longer expires.
            </p>
          )}

          {visibleMessage && (
            <Alert
              variant={visibleMessage.tone === "error" ? "destructive" : "default"}
              role={visibleMessage.tone === "error" ? "alert" : "status"}
            >
              <AlertDescription className="text-current">{visibleMessage.text}</AlertDescription>
            </Alert>
          )}

          {canClaim && (
            <Button disabled={pending !== null} onClick={() => run("claim")}>
              {pending === "claim" ? "Claiming…" : `Claim as ${actingName}`}
            </Button>
          )}

          {activeHeldClaim && activeHeldClaim.installerId !== actingInstallerId && (
            <p className="text-muted-foreground">
              Switch “Acting as installer” to {getInstallerName(activeHeldClaim.installerId)} to
              finish this claim.
            </p>
          )}

          {activeHeldClaim && activeHeldClaim.installerId === actingInstallerId && (
            <section
              aria-labelledby="verification-demo-title"
              className="grid gap-2 rounded-lg border border-dashed border-amber-400 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40"
            >
              <h3 id="verification-demo-title" className="flex items-center gap-1.5 font-medium">
                <FlaskConical aria-hidden="true" className="size-4" />
                Verification simulation (demo)
              </h3>
              <p className="text-xs text-muted-foreground">
                No real identity or payment check runs. Choose the result a verification provider
                would report.
              </p>
              {/* Stacked at every width: the dialog is too narrow for two full labels side by side. */}
              <div className="grid gap-2" data-verification-actions>
                <Button
                  className="h-auto min-h-8 py-1.5 whitespace-normal"
                  disabled={pending !== null}
                  onClick={() => run("PASSED")}
                >
                  {pending === "PASSED" ? "Sending…" : "Simulate: verification passed"}
                </Button>
                <Button
                  className="h-auto min-h-8 py-1.5 whitespace-normal"
                  variant="destructive"
                  disabled={pending !== null}
                  onClick={() => run("FAILED")}
                >
                  {pending === "FAILED" ? "Sending…" : "Simulate: verification failed"}
                </Button>
              </div>
            </section>
          )}

          {effective === "PENDING" && !holdsActiveClaim && (
            <p className="text-muted-foreground">
              Only the installer who claimed this job, in the tab that claimed it, can complete
              verification. If it is not verified in time, the job returns to the marketplace.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={pending !== null} onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
