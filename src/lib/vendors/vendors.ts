// Fixed demo vendors and the vendor assignment rules. Shared by the UI and the
// server, so no server-only imports. This is not a vendor management system:
// there is no vendor login and vendors cannot be added or edited.
import type { OrderStatus } from "@/lib/orders/status";

export const DEMO_VENDORS = [
  { id: "vendor-brightline", name: "Brightline Signs" },
  { id: "vendor-metro", name: "Metro Sign Works" },
  { id: "vendor-coastal", name: "Coastal Print & Fab" },
] as const;

export type DemoVendorId = (typeof DEMO_VENDORS)[number]["id"];

export const DEMO_VENDOR_IDS = DEMO_VENDORS.map((vendor) => vendor.id) as [DemoVendorId, ...DemoVendorId[]];

/** The vendor can be assigned, changed or removed only before a vendor accepts the order. */
export const VENDOR_EDITABLE_STATUSES: readonly OrderStatus[] = ["DRAFT", "SUBMITTED"];

/** Moving to this status requires an assigned vendor. */
export const VENDOR_REQUIRED_FOR: OrderStatus = "VENDOR_ACCEPTED";

export function canChangeVendor(status: OrderStatus): boolean {
  return VENDOR_EDITABLE_STATUSES.includes(status);
}

export function getVendorName(id: string | null): string | null {
  if (!id) return null;
  return DEMO_VENDORS.find((vendor) => vendor.id === id)?.name ?? id;
}
