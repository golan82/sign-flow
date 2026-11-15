// Order status state machine. Shared by the UI and the server, so this module
// must stay free of server-only imports.
//
// DRAFT -> SUBMITTED -> VENDOR_ACCEPTED -> IN_PRODUCTION -> READY_FOR_INSTALL -> COMPLETED
// CANCELLED is reachable only before IN_PRODUCTION. COMPLETED and CANCELLED are final.

export const ORDER_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "VENDOR_ACCEPTED",
  "IN_PRODUCTION",
  "READY_FOR_INSTALL",
  "COMPLETED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["VENDOR_ACCEPTED", "CANCELLED"],
  VENDOR_ACCEPTED: ["IN_PRODUCTION", "CANCELLED"],
  IN_PRODUCTION: ["READY_FOR_INSTALL"],
  READY_FOR_INSTALL: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function getAllowedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  VENDOR_ACCEPTED: "Vendor accepted",
  IN_PRODUCTION: "In production",
  READY_FOR_INSTALL: "Ready for install",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

// Label for the action that moves an order into the given status.
export const TRANSITION_ACTION_LABELS: Record<OrderStatus, string> = {
  DRAFT: "Move to draft",
  SUBMITTED: "Submit order",
  VENDOR_ACCEPTED: "Mark vendor accepted",
  IN_PRODUCTION: "Start production",
  READY_FOR_INSTALL: "Mark ready for install",
  COMPLETED: "Mark completed",
  CANCELLED: "Cancel order",
};
