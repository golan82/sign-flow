"use client";

import { useId, useRef, useState } from "react";

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
import { Label } from "@/components/ui/label";
import { assignVendorRequest } from "@/lib/orders/api-client";
import type { OrderDto } from "@/lib/orders/types";
import { DEMO_VENDORS, type DemoVendorId } from "@/lib/vendors/vendors";

export type VendorOutcome =
  | { kind: "changed"; order: OrderDto }
  | { kind: "conflict" }
  | { kind: "not-found" };

/** Assign or change the demo vendor of a DRAFT/SUBMITTED order. */
export function VendorDialog({
  order,
  onOutcome,
}: {
  order: OrderDto;
  onOutcome: (outcome: VendorOutcome) => void;
}) {
  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState<string>(order.vendorId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const selectId = useId();

  function handleOpenChange(next: boolean) {
    if (pendingRef.current) return;
    setOpen(next);
    if (next) {
      setVendorId(order.vendorId ?? "");
      setError(null);
    }
  }

  async function save() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await assignVendorRequest(order.id, {
        vendorId: vendorId ? (vendorId as DemoVendorId) : null,
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
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Vendor<span className="sr-only">: {order.title}</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Vendor assignment</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{order.title}</span>. The vendor can be
            changed until it accepts the order, and is required before “Mark vendor accepted”.
            Vendors are fixed demo data.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-2">
          <Label htmlFor={selectId}>Vendor</Label>
          <select
            id={selectId}
            value={vendorId}
            disabled={pending}
            onChange={(event) => setVendorId(event.target.value)}
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="">No vendor</option>
            {DEMO_VENDORS.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending || vendorId === (order.vendorId ?? "")} onClick={save}>
            {pending ? "Saving…" : "Save vendor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
