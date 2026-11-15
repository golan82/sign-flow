"use client";

import { useRef, useState } from "react";

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
import { changeStatusRequest } from "@/lib/orders/api-client";
import {
  getAllowedTransitions,
  ORDER_STATUS_LABELS,
  TRANSITION_ACTION_LABELS,
  type OrderStatus,
} from "@/lib/orders/status";
import type { OrderDto } from "@/lib/orders/types";
import { VENDOR_REQUIRED_FOR } from "@/lib/vendors/vendors";

export type StatusChangeOutcome =
  | { kind: "changed"; order: OrderDto }
  | { kind: "conflict" }
  | { kind: "not-found" };

export function ChangeStatusDialog({
  order,
  onOutcome,
}: {
  order: OrderDto;
  onOutcome: (outcome: StatusChangeOutcome) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<OrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const allowed = getAllowedTransitions(order.status);

  function handleOpenChange(next: boolean) {
    // Keep the dialog open while the request is in flight.
    if (pendingRef.current) return;
    setOpen(next);
    if (next) setError(null);
  }

  async function changeStatus(targetStatus: OrderStatus) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPendingTarget(targetStatus);
    setError(null);
    try {
      const result = await changeStatusRequest(order.id, {
        targetStatus,
        expectedVersion: order.version,
      });
      if (result.ok) {
        setOpen(false);
        onOutcome({ kind: "changed", order: result.data.order });
      } else if (result.status === 409) {
        setOpen(false);
        onOutcome({ kind: "conflict" });
      } else if (result.status === 404) {
        setOpen(false);
        onOutcome({ kind: "not-found" });
      } else {
        setError(result.error.message);
      }
    } finally {
      pendingRef.current = false;
      setPendingTarget(null);
    }
  }

  const pending = pendingTarget !== null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Change status<span className="sr-only">: {order.title}</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change status</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{order.title}</span> is currently{" "}
            <span className="font-medium text-foreground">
              {ORDER_STATUS_LABELS[order.status]}
            </span>
            . Choose the next status.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-2">
          {allowed.map((target) => {
            const needsVendor = target === VENDOR_REQUIRED_FOR && !order.vendorId;
            return (
              <Button
                key={target}
                variant={target === "CANCELLED" ? "destructive" : "default"}
                disabled={pending || needsVendor}
                aria-describedby={needsVendor ? "vendor-required-hint" : undefined}
                onClick={() => changeStatus(target)}
              >
                {pendingTarget === target ? "Updating…" : TRANSITION_ACTION_LABELS[target]}
              </Button>
            );
          })}
        </div>
        {allowed.includes(VENDOR_REQUIRED_FOR) && !order.vendorId && (
          <p id="vendor-required-hint" className="text-xs text-muted-foreground">
            Assign a vendor (Vendor button) before marking the order as vendor accepted.
          </p>
        )}
        {allowed.includes("CANCELLED") && (
          <p className="text-xs text-muted-foreground">
            Cancelling is final and is only possible before production starts.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
