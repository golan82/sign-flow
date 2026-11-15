"use client";

import { useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, ClipboardList, Factory, RefreshCw, X } from "lucide-react";

import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { CLAIMABLE_STATUS } from "@/lib/claims/constants.mts";
import { findEndedHeldClaims, matchingHeldClaim, type HeldClaim } from "@/lib/claims/held-claims";
import { claimExpiredNotice } from "@/lib/claims/messages";
import { isTerminalStatus, ORDER_STATUS_LABELS } from "@/lib/orders/status";
import type { OrderDto } from "@/lib/orders/types";
import { cn } from "@/lib/utils";
import { canChangeVendor, getVendorName } from "@/lib/vendors/vendors";

import { PrintFilesDialog } from "@/components/uploads/print-files-dialog";
import { UploadSummary } from "@/components/uploads/upload-summary";
import { useUploadManager, type LocalUpload } from "@/components/uploads/use-upload-manager";

import { ChangeStatusDialog, type StatusChangeOutcome } from "./change-status-dialog";
import { ClaimSummary } from "./claim-summary";
import { CreateOrderDialog } from "./create-order-dialog";
import { InstallerAssignmentDialog } from "./installer-assignment-dialog";
import { InstallerPicker } from "./installer-picker";
import { StatusBadge } from "./status-badge";
import { useOrdersLive, useServerNow, type LiveStatus } from "./use-orders-live";
import { useTabInstaller } from "./use-tab-installer";
import { VendorDialog, type VendorOutcome } from "./vendor-dialog";

/** `expiredClaimOn`: the order whose claim expiry this notice reports. */
type Notice = { tone: "success" | "error"; text: string; expiredClaimOn?: string };

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function OrdersDashboard() {
  const { orders, loading, loadError, liveStatus, clock, reload, applyOrder } = useOrdersLive();
  const [actingInstaller, setActingInstaller] = useTabInstaller();
  const [notice, setNotice] = useState<Notice | null>(null);
  // Claim tokens this tab received. Memory only: never in the URL or storage.
  const [heldClaims, setHeldClaims] = useState<Record<string, HeldClaim>>({});
  const { uploads: localUploads, start: startUpload, cancel: cancelUpload } = useUploadManager();

  // Tick the server clock while anything time-limited is pending.
  const hasPendingClaims = !!orders?.some(
    (order) =>
      order.claim.state === "PENDING_VERIFICATION" ||
      order.uploads.some((upload) => upload.status === "PENDING_UPLOAD"),
  );
  const serverNow = useServerNow(clock, hasPendingClaims);

  // Tell this tab when its own claim expired before verification, and drop
  // tokens of claims that are over. Adjusted during render from the latest
  // order data (React's pattern for state that follows new data), so the
  // notice appears whether this tab saw the claim expire or only its release
  // by the worker. A failed or passed verification is never reported here.
  const endedClaims = findEndedHeldClaims(orders ?? [], Object.values(heldClaims), serverNow);
  if (endedClaims.length > 0) {
    const expired = endedClaims.findLast((ended) => ended.expired);
    if (expired) {
      setNotice({ tone: "error", text: claimExpiredNotice(expired.title), expiredClaimOn: expired.orderId });
    }
    setHeldClaims((current) => {
      const next = { ...current };
      for (const ended of endedClaims) delete next[ended.orderId];
      return next;
    });
  }

  function forgetHeldClaim(orderId: string) {
    setHeldClaims((current) => {
      if (!(orderId in current)) return current;
      const next = { ...current };
      delete next[orderId];
      return next;
    });
  }

  function handleCreated(order: OrderDto) {
    setNotice({ tone: "success", text: `Order “${order.title}” was created as a draft.` });
    applyOrder(order);
    reload();
  }

  function handleStatusOutcome(outcome: StatusChangeOutcome) {
    if (outcome.kind === "changed") {
      applyOrder(outcome.order);
      setNotice({
        tone: "success",
        text: `“${outcome.order.title}” is now ${ORDER_STATUS_LABELS[outcome.order.status]}.`,
      });
    } else if (outcome.kind === "conflict") {
      setNotice({
        tone: "error",
        text: "This order was changed by someone else, so your change was not applied. The list has been refreshed — review the current status and try again.",
      });
    } else {
      setNotice({ tone: "error", text: "This order no longer exists. The list has been refreshed." });
    }
    reload();
  }

  function handleVendorOutcome(outcome: VendorOutcome) {
    if (outcome.kind !== "changed") return handleStatusOutcome(outcome);
    applyOrder(outcome.order);
    const vendor = getVendorName(outcome.order.vendorId);
    setNotice({
      tone: "success",
      text: vendor
        ? `“${outcome.order.title}” is assigned to ${vendor}.`
        : `The vendor was removed from “${outcome.order.title}”.`,
    });
    reload();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Orders</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>All signage orders, newest first.</span>
          <LiveIndicator status={liveStatus} />
        </CardDescription>
        <CardAction>
          <CreateOrderDialog onCreated={handleCreated} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <InstallerPicker value={actingInstaller} onChange={setActingInstaller} />

        {notice && (
          <Alert
            variant={notice.tone === "error" ? "destructive" : "default"}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            {notice.tone === "error" ? (
              <CircleAlert aria-hidden="true" />
            ) : (
              <CircleCheck aria-hidden="true" />
            )}
            <AlertDescription className="text-current">{notice.text}</AlertDescription>
            <AlertAction>
              <Button variant="ghost" size="icon-xs" onClick={() => setNotice(null)}>
                <X aria-hidden="true" />
                <span className="sr-only">Dismiss message</span>
              </Button>
            </AlertAction>
          </Alert>
        )}

        {loadError && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>
              {orders ? "Could not refresh the orders. " : "Could not load the orders. "}
              {loadError}
            </AlertDescription>
            <AlertAction>
              <Button variant="outline" size="xs" disabled={loading} onClick={reload}>
                <RefreshCw aria-hidden="true" />
                Try again
              </Button>
            </AlertAction>
          </Alert>
        )}

        <div aria-busy={loading}>
          {orders === null ? (
            loading && <OrdersSkeleton />
          ) : orders.length === 0 ? (
            <Empty className="border py-12 sm:py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ClipboardList aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No orders yet</EmptyTitle>
                <EmptyDescription>
                  Create the first signage order with <strong>New order</strong>.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y rounded-lg border">
              {orders.map((order) => {
                const held = matchingHeldClaim(order, heldClaims[order.id]);
                return (
                  <OrderRow
                    key={order.id}
                    order={order}
                    serverNow={serverNow}
                    claimControls={
                      order.status === CLAIMABLE_STATUS ? (
                        <InstallerAssignmentDialog
                          order={order}
                          actingInstallerId={actingInstaller}
                          heldClaim={held}
                          serverNow={serverNow}
                          onClaimed={(claimed, claim) => {
                            setHeldClaims((current) => ({ ...current, [claimed.id]: claim }));
                            // A new claim on the same job supersedes the old expiry notice.
                            setNotice((current) => (current?.expiredClaimOn === claimed.id ? null : current));
                            applyOrder(claimed);
                          }}
                          onVerifying={(orderId, verifying) =>
                            setHeldClaims((current) =>
                              orderId in current
                                ? { ...current, [orderId]: { ...current[orderId], verifying } }
                                : current,
                            )
                          }
                          onClaimFinished={forgetHeldClaim}
                          onChanged={(changed) => {
                            if (changed) applyOrder(changed);
                            reload();
                          }}
                        />
                      ) : null
                    }
                    heldByThisTab={held !== undefined}
                    localUpload={localUploads[order.id]}
                    uploadControls={
                      <PrintFilesDialog
                        order={order}
                        local={localUploads[order.id]}
                        serverNow={serverNow}
                        onStart={(file, simulateFailure) => void startUpload(order.id, file, simulateFailure)}
                        onCancel={() => cancelUpload(order.id)}
                      />
                    }
                    vendorControls={
                      canChangeVendor(order.status) ? (
                        <VendorDialog order={order} onOutcome={handleVendorOutcome} />
                      ) : null
                    }
                    onStatusOutcome={handleStatusOutcome}
                  />
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LiveIndicator({ status }: { status: LiveStatus }) {
  const label = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…" }[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" role="status" data-live-status={status}>
      <span
        aria-hidden="true"
        className={cn(
          "size-2 rounded-full",
          status === "live" ? "bg-emerald-500" : "animate-pulse bg-amber-500",
        )}
      />
      {label}
    </span>
  );
}

function OrderRow({
  order,
  serverNow,
  claimControls,
  heldByThisTab,
  localUpload,
  uploadControls,
  vendorControls,
  onStatusOutcome,
}: {
  order: OrderDto;
  serverNow: number;
  claimControls: ReactNode;
  heldByThisTab: boolean;
  localUpload: LocalUpload | undefined;
  uploadControls: ReactNode;
  vendorControls: ReactNode;
  onStatusOutcome: (outcome: StatusChangeOutcome) => void;
}) {
  const showClaim = order.status === CLAIMABLE_STATUS || order.claim.state === "CONFIRMED";
  const vendorName = getVendorName(order.vendorId);
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="font-medium break-words">{order.title}</p>
        {order.description && (
          <p className="line-clamp-2 text-sm break-words text-muted-foreground">
            {order.description}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Created{" "}
          <time dateTime={order.createdAt}>
            {dateFormatter.format(new Date(order.createdAt))}
          </time>
        </p>
        {(vendorName || canChangeVendor(order.status)) && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-vendor={order.vendorId ?? ""}>
            <Factory aria-hidden="true" className="size-3.5 shrink-0" />
            {vendorName ? `Vendor: ${vendorName}` : "No vendor assigned"}
          </p>
        )}
        {showClaim && (
          <ClaimSummary claim={order.claim} serverNow={serverNow} heldByThisTab={heldByThisTab} />
        )}
        <UploadSummary uploads={order.uploads} local={localUpload} serverNow={serverNow} />
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 sm:justify-end">
        <StatusBadge status={order.status} />
        <div className="flex flex-wrap gap-2">
          {vendorControls}
          {uploadControls}
          {claimControls}
          {isTerminalStatus(order.status) ? (
            <span className="text-xs text-muted-foreground">Final status</span>
          ) : (
            <ChangeStatusDialog order={order} onOutcome={onStatusOutcome} />
          )}
        </div>
      </div>
    </li>
  );
}

function OrdersSkeleton() {
  return (
    <div className="divide-y rounded-lg border" aria-label="Loading orders">
      {[0, 1, 2].map((key) => (
        <div key={key} className="flex items-center justify-between gap-4 p-4">
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}
