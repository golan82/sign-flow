// Caps on demo data, so a public demo cannot grow without bound: every live
// update re-reads and sends the whole (unpaginated) order list. They limit
// stored data only, not request rates, SSE connections or traffic.
// Shared by the server and the UI, so no server-only imports here.

/** Orders in the whole database. Enforced in createOrder (src/lib/orders/service.ts). */
export const MAX_DEMO_ORDERS = 200;

/**
 * Upload attempts per order, including failed, cancelled and expired ones.
 * Enforced in authorizeUpload (src/lib/uploads/service.ts); repeating a
 * request for an existing attempt does not count again.
 */
export const MAX_UPLOAD_ATTEMPTS_PER_ORDER = 20;
