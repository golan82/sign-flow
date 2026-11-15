// End-to-end UI check in two browser windows (A at 390 px, B at desktop width),
// driven through the Chrome DevTools Protocol of an installed Edge/Chrome.
//
//   npm run build            (once; the check runs `next start`)
//   npm run db:up; npm run db:push:test
//   npm run test:ui
//
// Covers: order creation and a status change, two installers racing for a
// claim, verification, claim expiry (+ the expiry worker), a simulated upload
// (print files dialog at 390×844 and 768×1024 before, during and with file
// history), an expired claim taken over by another installer who fails, claims
// again, passes and completes (no stale messages or false expiry notices in
// either window), the verification buttons' layout, live updates in the other
// window, the 390 px layout, and the demo data limits (upload attempts per
// order, total orders) as shown in the dialogs.
// Uses only TEST_DATABASE_URL (guarded) and deletes only what it created.
// Optional env: UI_TEST_BROWSER (browser executable), UI_TEST_PORT (default 3100).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import prismaClient from "@prisma/client";

import { MAX_DEMO_ORDERS, MAX_UPLOAD_ATTEMPTS_PER_ORDER } from "../../src/lib/demo-limits.mts";
import { assertSafeTestDatabase } from "../support/test-database.mts";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const testUrl = process.env.TEST_DATABASE_URL;
assertSafeTestDatabase(testUrl, process.env.DATABASE_URL);

const APP_PORT = Number(process.env.UI_TEST_PORT ?? 3100);
const APP = `http://127.0.0.1:${APP_PORT}`;
const CDP_PORT = 9339;
const RESULTS_DIR = path.join(projectRoot, "test-results", "ui");
const PREFIX = `ui-test ${Date.now()}`;

const { PrismaClient } = prismaClient;
const db = new PrismaClient({ datasourceUrl: testUrl });
const createdOrderIds = new Set<string>();
const results: boolean[] = [];
const children: ChildProcess[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name: string, ok: boolean, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function findBrowser(): string {
  const candidates = [
    process.env.UI_TEST_BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const found = candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate));
  if (!found) throw new Error("No Edge/Chrome found. Set UI_TEST_BROWSER to a Chromium-based browser executable.");
  return found;
}

function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already gone
    }
  } else {
    child.kill("SIGTERM");
  }
}

// ---- Chrome DevTools Protocol page ---------------------------------------------

type CdpMessage = { id?: number; result?: Record<string, unknown>; error?: { message: string } };

// Plain fields only: Node runs this file with type stripping, which does not
// support TypeScript parameter properties.
class Page {
  nextId = 0;
  readonly pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  readonly ws: WebSocket;
  readonly name: string;

  constructor(ws: WebSocket, name: string) {
    this.ws = ws;
    this.name = name;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      const waiter = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (!waiter || message.id === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? {});
    });
  }

  static async open(webSocketUrl: string, name: string): Promise<Page> {
    const ws = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const page = new Page(ws, name);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    return page;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const details = response.exceptionDetails as { text?: string } | undefined;
    if (details) throw new Error(`[${this.name}] evaluate failed: ${details.text}`);
    return (response.result as { value: T }).value;
  }

  async waitFor(expression: string, label: string, timeoutMs = 20_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.evaluate<boolean>(expression)) return;
      await sleep(150);
    }
    throw new Error(`[${this.name}] timed out waiting for: ${label}`);
  }

  setViewport(width: number, height: number) {
    return this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
  }

  async screenshot(file: string) {
    // A background tab may not produce a new frame (e.g. after a viewport
    // change), and the capture then waits for one indefinitely.
    await this.send("Page.bringToFront");
    const { data } = (await this.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    writeFileSync(path.join(RESULTS_DIR, `${file}.png`), Buffer.from(data, "base64"));
  }

  close() {
    this.ws.close();
  }
}

// ---- DOM helpers (run inside the page) ----------------------------------------------

const js = JSON.stringify;
const DIALOG = `document.querySelector('[role="dialog"][data-state="open"]')`;
const dialogText = `(${DIALOG}?.innerText ?? "")`;
const row = (title: string) => `[...document.querySelectorAll("ul li")].find((li) => li.innerText.includes(${js(title)}))`;
const rowText = (title: string) => `(${row(title)}?.innerText ?? "")`;
const rowClaimState = (title: string) => `(${row(title)}?.querySelector("[data-claim-state]")?.dataset.claimState ?? "")`;
const clickRowButton = (title: string, label: string) =>
  `(() => { const b = [...(${row(title)}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.startsWith(${js(label)})); if (!b) return false; b.click(); return true; })()`;
const clickDialogButton = (label: string) =>
  `(() => { const b = [...(${DIALOG}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim().startsWith(${js(label)})); if (!b) return false; b.click(); return true; })()`;
const liveStatus = `(document.querySelector("[data-live-status]")?.dataset.liveStatus ?? "")`;
const setActingInstaller = (id: string) =>
  `(() => { const s = document.getElementById("acting-installer"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, ${js(id)}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`;
// Messages that claim more than the latest order data supports (regression).
const STALE_CLAIM_TEXTS = ["Claimed as Jordan Lee", "open to installers again", "available to installers again", "available again"];
const staleClaimTexts = `${js(STALE_CLAIM_TEXTS)}.filter((text) => document.body.innerText.includes(text))`;

type VerificationLayout = {
  labels: string[];
  stacked: boolean;
  insideDialog: boolean;
  clipped: string[];
};
// The two demo verification buttons: full labels, one above the other, inside the dialog.
const verificationLayout = `(() => {
  const dialog = ${DIALOG};
  const buttons = [...(dialog?.querySelectorAll("[data-verification-actions] button") ?? [])];
  if (!dialog || buttons.length !== 2) return null;
  const box = dialog.getBoundingClientRect();
  const [a, b] = buttons.map((el) => el.getBoundingClientRect());
  return {
    labels: buttons.map((el) => el.textContent.trim()),
    stacked: b.top >= a.bottom,
    insideDialog: [a, b].every((r) => r.left >= box.left && r.right <= box.right && r.right <= window.innerWidth),
    clipped: buttons.filter((el) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight).map((el) => el.textContent.trim()),
  };
})()`;

type DialogLayout = { fits: boolean; escaping: string[]; clipped: string[]; missing: string[] };
// The open dialog: inside the viewport, no element sticking out of it, no button
// whose label overflows it, and the given texts (names, sizes, statuses, button
// labels) present. Truncated file names keep their full text in the DOM.
const dialogLayout = (expected: string[]) => `(() => {
  const dialog = ${DIALOG};
  if (!dialog) return null;
  const box = dialog.getBoundingClientRect();
  const label = (el) => el.tagName.toLowerCase() + " " + JSON.stringify((el.textContent ?? "").trim().slice(0, 40));
  // Visible horizontal extent: clipped by ancestors (below the dialog) that do
  // not show overflow, e.g. the progress indicator inside its track.
  const visible = (el) => {
    let { left, right } = el.getBoundingClientRect();
    for (let parent = el.parentElement; parent && parent !== dialog; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX === "visible") continue;
      const r = parent.getBoundingClientRect();
      left = Math.max(left, r.left);
      right = Math.min(right, r.right);
    }
    return { left, right };
  };
  const escaping = [...dialog.querySelectorAll("*")].filter((el) => {
    const r = visible(el);
    return r.right - r.left > 1 && (r.left < box.left - 0.5 || r.right > box.right + 0.5);
  });
  const clipped = [...dialog.querySelectorAll("button")].filter((el) => el.scrollWidth > el.clientWidth + 1);
  return {
    fits: box.left >= 0 && box.right <= window.innerWidth && dialog.scrollWidth <= dialog.clientWidth,
    escaping: escaping.slice(0, 5).map(label),
    clipped: clipped.map(label),
    missing: ${js(expected)}.filter((text) => !dialog.innerText.includes(text)),
  };
})()`;

/** Checks the open dialog in page A at 390×844 and 768×1024, then returns to 390. */
async function checkDialogAtWidths(page: Page, state: string, expected: string[]) {
  for (const [width, height] of [[390, 844], [768, 1024]]) {
    await page.setViewport(width, height);
    await sleep(250);
    const layout = await page.evaluate<DialogLayout | null>(dialogLayout(expected));
    const ok = !!layout && layout.fits && layout.escaping.length === 0 && layout.clipped.length === 0 && layout.missing.length === 0;
    check(`print files dialog ${state} fits at ${width}×${height}`, ok, ok ? "" : JSON.stringify(layout));
    await page.screenshot(`A-print-files-${state.replaceAll(" ", "-")}-${width}`);
  }
  await page.setViewport(390, 844);
}

/** Seeds one finished upload through the API (authorize, then complete or abort). */
async function seedUpload(orderId: string, originalName: string, end: "complete" | "CANCELLED" | "FAILED") {
  const auth = (await (
    await fetch(`${APP}/api/orders/${orderId}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientRequestId: crypto.randomUUID(), originalName, sizeBytes: 1_610_612_736, contentType: "application/pdf" }),
    })
  ).json()) as { uploadUrl: string; upload: { id: string } };
  const action = end === "complete" ? "complete" : "abort";
  const body = end === "complete" ? { uploadUrl: auth.uploadUrl } : { uploadUrl: auth.uploadUrl, reason: end };
  const response = await fetch(`${APP}/api/orders/${orderId}/uploads/${auth.upload.id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) throw new Error(`seed upload ${end}: HTTP ${response.status}`);
}

function checkVerificationLayout(width: string, layout: VerificationLayout | null) {
  const ok =
    !!layout &&
    layout.labels.join() === "Simulate: verification passed,Simulate: verification failed" &&
    layout.stacked &&
    layout.insideDialog &&
    layout.clipped.length === 0;
  check(`verification buttons are stacked with full labels (${width})`, ok, JSON.stringify(layout));
}

async function api(method: string, url: string, body?: unknown) {
  const response = await fetch(`${APP}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { order: { id: string; version: number } } };
}

/** Creates an order through the API and moves it to READY_FOR_INSTALL. */
async function createReadyOrder(label: string) {
  const title = `${PREFIX} ${label}`;
  const created = await api("POST", "/api/orders", { title });
  const id = created.body.order.id;
  createdOrderIds.add(id);
  await api("PATCH", `/api/orders/${id}/vendor`, { vendorId: "vendor-metro", expectedVersion: 0 });
  const steps = ["SUBMITTED", "VENDOR_ACCEPTED", "IN_PRODUCTION", "READY_FOR_INSTALL"];
  for (const [index, targetStatus] of steps.entries()) {
    const response = await api("PATCH", `/api/orders/${id}/status`, { targetStatus, expectedVersion: index + 1 });
    if (response.status !== 200) throw new Error(`setup: ${targetStatus} failed with HTTP ${response.status}`);
  }
  return { id, title };
}

// ---- run -----------------------------------------------------------------------------

let pageA: Page | undefined;
let pageB: Page | undefined;
const profileDir = mkdtempSync(path.join(os.tmpdir(), "signflow-ui-"));

try {
  if (!existsSync(path.join(projectRoot, ".next", "BUILD_ID"))) {
    throw new Error("No production build found. Run `npm run build` first.");
  }
  const portTaken = await fetch(APP).then(() => true, () => false);
  if (portTaken) throw new Error(`Port ${APP_PORT} is already in use. Set UI_TEST_PORT to a free port.`);
  mkdirSync(RESULTS_DIR, { recursive: true });

  const appEnv = { ...process.env, DATABASE_URL: testUrl };
  const server = spawn(
    process.execPath,
    [path.join(projectRoot, "node_modules/next/dist/bin/next"), "start", "-p", String(APP_PORT)],
    { cwd: projectRoot, env: appEnv, stdio: ["ignore", "ignore", "inherit"] },
  );
  children.push(server);
  const browser = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  children.push(browser);

  for (let i = 0; i < 120; i++) {
    if (await fetch(APP).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }

  type Target = { type: string; webSocketDebuggerUrl: string };
  let targets: Target[] = [];
  for (let i = 0; i < 50 && targets.length === 0; i++) {
    targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      .then((r) => r.json() as Promise<Target[]>)
      .then((list) => list.filter((t) => t.type === "page"), () => []);
    if (targets.length === 0) await sleep(200);
  }
  const second = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json()) as Target;
  const A = (pageA = await Page.open(targets[0].webSocketDebuggerUrl, "A"));
  const B = (pageB = await Page.open(second.webSocketDebuggerUrl, "B"));
  await A.setViewport(390, 844);
  await B.setViewport(1280, 900);
  for (const page of [A, B]) {
    await page.send("Page.navigate", { url: APP });
    await page.waitFor(`${liveStatus} === "live"`, "live updates connected");
  }
  check("both windows load and connect live updates", true);

  // 1. Create an order in A and change its status; B follows live.
  const created = `${PREFIX} Storefront sign`;
  await A.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New order").click()`);
  await A.waitFor(`document.activeElement?.id === "order-title"`, "create dialog focused");
  await A.send("Input.insertText", { text: created });
  await A.evaluate(clickDialogButton("Create order"));
  await B.waitFor(`${rowText(created)}.includes("Draft")`, "new order visible in B");
  const createdId = (await db.order.findFirstOrThrow({ where: { title: created } })).id;
  createdOrderIds.add(createdId);
  check("order created in A appears in B", true);
  // The create dialog must be fully closed first; a click during its closing
  // animation can count as an outside click and close the next dialog.
  await A.waitFor(`!document.querySelector('[role="dialog"]')`, "create dialog closed");
  await A.evaluate(clickRowButton(created, "Change status"));
  await A.waitFor(`${dialogText}.includes("Submit order")`, "status dialog");
  await A.evaluate(clickDialogButton("Submit order"));
  await B.waitFor(`${rowText(created)}.includes("Submitted")`, "status visible in B");
  check("status change in A appears in B", true);

  // 2. Two installers race for the same job: exactly one wins.
  const job = await createReadyOrder("Shopfront install");
  await A.evaluate(setActingInstaller("installer-sam"));
  for (const [page, name] of [[A, "Sam Patel"], [B, "Alex Rivera"]] as const) {
    await page.waitFor(`${rowText(job.title)}.includes("Open for installers")`, "job open");
    await page.evaluate(clickRowButton(job.title, "Installer assignment"));
    await page.waitFor(`${dialogText}.includes("Claim as ${name}")`, "claim button");
  }
  const clicked = await Promise.all([
    A.evaluate<boolean>(clickDialogButton("Claim as Sam Patel")),
    B.evaluate<boolean>(clickDialogButton("Claim as Alex Rivera")),
  ]);
  if (!clicked.every(Boolean)) throw new Error(`claim buttons not clicked in both windows: ${clicked}`);
  const outcome = (page: Page) =>
    page.evaluate<string>(
      `${dialogText}.includes("Another installer claimed this job first") ? "lost" : ${dialogText}.includes("Claimed as") ? "won" : ""`,
    );
  let outcomes = ["", ""];
  for (let i = 0; i < 100 && outcomes.includes(""); i++) {
    await sleep(150);
    outcomes = [await outcome(A), await outcome(B)];
  }
  check(
    "two installers claim at once: one wins, the other sees a conflict",
    [...outcomes].sort().join() === "lost,won",
    `A ${outcomes[0]}, B ${outcomes[1]}`,
  );
  const [winner, loser] = (await outcome(A)) === "won" ? [A, B] : [B, A];
  const winnerName = winner === A ? "Sam Patel" : "Alex Rivera";

  // 3. Verification (simulated) confirms; the other window shows the assignment.
  await winner.waitFor(`${dialogText}.includes("Simulate: verification passed")`, "demo verification panel");
  await winner.evaluate(clickDialogButton("Simulate: verification passed"));
  await loser.waitFor(`${rowText(job.title)}.includes("Installer: ${winnerName} · verified")`, "verified in other window");
  check("verification confirms the claim in both windows", true);
  for (const page of [A, B]) await page.evaluate(clickDialogButton("Close"));

  // 4. Expiry: shown as expired before cleanup, then released by the worker.
  const expiring = await createReadyOrder("Window decal install");
  await A.waitFor(`${rowText(expiring.title)}.includes("Open for installers")`, "second job open");
  await A.evaluate(clickRowButton(expiring.title, "Installer assignment"));
  await A.waitFor(`${dialogText}.includes("Claim as Sam Patel")`, "claim button");
  await A.evaluate(clickDialogButton("Claim as Sam Patel"));
  await A.waitFor(`${dialogText}.includes("Simulate: verification passed")`, "claimed");
  await A.evaluate(clickDialogButton("Close"));
  // Dedicated expiry for this test record; the worker is not running yet.
  await db.order.update({ where: { id: expiring.id }, data: { claimExpiresAt: new Date(Date.now() - 1_000) } });
  await A.waitFor(`document.body.innerText.includes("expired before verification")`, "expiry message");
  await B.waitFor(`${rowClaimState(expiring.title)} === "EXPIRED"`, "expired in B");
  const pending = (await db.order.findUniqueOrThrow({ where: { id: expiring.id } })).claimState;
  check("expired claim shows as open before any cleanup", pending === "PENDING_VERIFICATION", `stored ${pending}`);
  const worker = spawn(process.execPath, [path.join(projectRoot, "scripts/claim-expiry-worker.mts")], {
    cwd: projectRoot,
    env: { ...appEnv, CLAIM_SWEEP_INTERVAL_MS: "500" },
    stdio: "ignore",
  });
  children.push(worker);
  await B.waitFor(`${rowClaimState(expiring.title)} === "AVAILABLE"`, "released by worker");
  check("the expiry worker releases it and both windows update", true);

  // 5. Simulated upload of the 1.5 GB demo file; B sees the stored metadata.
  //    The dialog layout is checked before, during and after (with history).
  const uploadPhase = `${DIALOG}?.querySelector("[data-upload-phase]")?.dataset.uploadPhase`;
  await A.evaluate(clickRowButton(job.title, "Print files"));
  await A.waitFor(`${dialogText}.includes("Simulated upload.")`, "upload dialog");
  await A.evaluate(clickDialogButton("Use a 1.5 GB demo print file"));
  await A.waitFor(`${dialogText}.includes("Demo · no content")`, "demo file selected");
  await checkDialogAtWidths(A, "before upload", [
    "storefront-banner-print-demo.pdf",
    "1.50 GB",
    "Demo · no content",
    "Start upload",
    "Close",
    "No files yet.",
  ]);
  await A.evaluate(clickDialogButton("Start upload"));
  await A.waitFor(`${uploadPhase} === "uploading"`, "upload in progress");
  await checkDialogAtWidths(A, "during upload", ["storefront-banner-print-demo.pdf", "/ 1.50 GB", "Uploading to simulated storage", "Cancel upload", "Close"]);
  await A.waitFor(`${uploadPhase} === "completed"`, "upload completed", 60_000);
  await B.waitFor(`${rowText(job.title)}.includes("(1.50 GB) uploaded")`, "upload visible in B");
  check("simulated upload completes and appears in the other window", true);
  const longName = "storefront-banner-print-demo-final-approved-by-client-v3.pdf";
  await seedUpload(job.id, longName, "complete");
  await seedUpload(job.id, `cancelled-${longName}`, "CANCELLED");
  await seedUpload(job.id, `failed-${longName}`, "FAILED");
  await A.waitFor(`${DIALOG}?.querySelectorAll("[data-upload-status]").length === 4`, "file history in A");
  await checkDialogAtWidths(A, "with history", [longName, `cancelled-${longName}`, "Uploaded (simulated)", "Cancelled", "Failed", "1.50 GB", "Upload another file", "Close"]);
  await A.evaluate(clickDialogButton("Close"));

  // 6. Jordan's claim (A, 390 px) expires, Sam (B, desktop) claims and is
  //    verified, then the job is completed. Jordan's window must follow the
  //    latest order data instead of keeping its earlier messages.
  const reassigned = await createReadyOrder("Lobby sign install");
  await A.evaluate(setActingInstaller("installer-jordan"));
  await B.evaluate(setActingInstaller("installer-sam"));
  await A.waitFor(`${rowText(reassigned.title)}.includes("Open for installers")`, "third job open");
  await A.evaluate(clickRowButton(reassigned.title, "Installer assignment"));
  await A.waitFor(`${dialogText}.includes("Claim as Jordan Lee")`, "claim button");
  await A.evaluate(clickDialogButton("Claim as Jordan Lee"));
  await A.waitFor(`${dialogText}.includes("Claimed as Jordan Lee") && ${dialogText}.includes("Simulate: verification passed")`, "Jordan claimed");
  checkVerificationLayout("390 px", await A.evaluate<VerificationLayout | null>(verificationLayout));
  await A.screenshot("A-390-verification");

  await db.order.update({ where: { id: reassigned.id }, data: { claimExpiresAt: new Date(Date.now() - 1_000) } });
  await A.waitFor(`document.body.innerText.includes(${js(`Your previous claim on “${reassigned.title}” expired before verification.`)})`, "past-tense expiry notice");
  check(
    "after expiry, Jordan's window drops “Claimed as Jordan Lee”",
    !(await A.evaluate<boolean>(`${dialogText}.includes("Claimed as Jordan Lee")`)),
  );

  await B.waitFor(`["AVAILABLE", "EXPIRED"].includes(${rowClaimState(reassigned.title)})`, "job open again in B");
  await B.evaluate(clickRowButton(reassigned.title, "Installer assignment"));
  await B.waitFor(`${dialogText}.includes("Claim as Sam Patel")`, "claim button");
  await B.evaluate(clickDialogButton("Claim as Sam Patel"));
  await B.waitFor(`${dialogText}.includes("Simulate: verification passed")`, "Sam claimed");
  checkVerificationLayout("desktop", await B.evaluate<VerificationLayout | null>(verificationLayout));
  await B.screenshot("B-desktop-verification");
  // Sam's first verification fails; Sam claims again and passes. Neither the
  // failure nor the confirmation may be reported as an expiry in B.
  await B.evaluate(clickDialogButton("Simulate: verification failed"));
  await B.waitFor(`${dialogText}.includes("Verification failed, so your claim was released.")`, "verification failed");
  await B.waitFor(`${dialogText}.includes("Claim as Sam Patel")`, "claim button again");
  await B.evaluate(clickDialogButton("Claim as Sam Patel"));
  await B.waitFor(`${dialogText}.includes("Simulate: verification passed")`, "Sam claimed again");
  await B.evaluate(clickDialogButton("Simulate: verification passed"));
  await A.waitFor(`${dialogText}.includes("Assigned to Sam Patel")`, "Sam's assignment in Jordan's dialog");
  const staleInA = await A.evaluate<string[]>(staleClaimTexts);
  check("after Sam is verified, Jordan's window shows no stale claim message", staleInA.length === 0, staleInA.join("; "));

  await B.evaluate(clickDialogButton("Close"));
  await B.evaluate(clickRowButton(reassigned.title, "Change status"));
  await B.waitFor(`${dialogText}.includes("Mark completed")`, "status dialog");
  await B.evaluate(clickDialogButton("Mark completed"));
  await A.waitFor(`${rowText(reassigned.title)}.includes("Completed")`, "completed in A");
  const staleAfterCompletion = await A.evaluate<string[]>(staleClaimTexts);
  check(
    "completed job: Jordan's window shows the final state without stale messages",
    staleAfterCompletion.length === 0 && (await A.evaluate<boolean>(`${rowText(reassigned.title)}.includes("Installer: Sam Patel · verified")`)),
    staleAfterCompletion.join("; "),
  );
  await A.screenshot("A-390-completed");
  check(
    "Sam's window (failed, claimed again, passed, completed) shows no expiry notice",
    !(await B.evaluate<boolean>(`document.body.innerText.includes("expired before verification")`)),
  );
  await B.screenshot("B-desktop-completed");

  // 7. 390 px layout.
  const overflow = await A.evaluate<number>("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  check("no horizontal overflow at 390 px", overflow <= 0, `overflow ${overflow}px`);

  // 8. Demo limits as the user sees them. Print files: with the order's
  //    attempts at the limit, the dialog says so and Start is disabled. New
  //    order: at the order limit, the server's refusal is shown in the dialog.
  for (let i = await db.upload.count({ where: { orderId: job.id } }); i < MAX_UPLOAD_ATTEMPTS_PER_ORDER; i++) {
    await seedUpload(job.id, `limit-attempt-${i}.pdf`, "CANCELLED");
  }
  await A.evaluate(clickRowButton(job.title, "Print files"));
  await A.waitFor(`${DIALOG}?.querySelectorAll("[data-upload-status]").length === ${MAX_UPLOAD_ATTEMPTS_PER_ORDER}`, "attempts at the limit");
  const startDisabled = await A.evaluate<boolean>(
    `(() => { const b = [...${DIALOG}.querySelectorAll("button")].find((b) => /Start upload|Upload another file/.test(b.textContent)); return !!b && b.disabled; })()`,
  );
  check(
    `print files: the ${MAX_UPLOAD_ATTEMPTS_PER_ORDER}-attempt limit is shown and Start is disabled`,
    startDisabled && (await A.evaluate<boolean>(`${dialogText}.includes("reached the demo limit of ${MAX_UPLOAD_ATTEMPTS_PER_ORDER} upload attempts")`)),
  );
  await A.evaluate(clickDialogButton("Close"));

  for (let i = await db.order.count(); i < MAX_DEMO_ORDERS; i++) {
    createdOrderIds.add((await api("POST", "/api/orders", { title: `${PREFIX} limit filler ${i}` })).body.order.id);
  }
  await B.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New order").click()`);
  await B.waitFor(`document.activeElement?.id === "order-title"`, "create dialog focused");
  await B.send("Input.insertText", { text: `${PREFIX} over the limit` });
  await B.evaluate(clickDialogButton("Create order"));
  await B.waitFor(`${dialogText}.includes("at most ${MAX_DEMO_ORDERS} orders")`, "order limit message", 30_000);
  check(
    `new order: at ${MAX_DEMO_ORDERS} orders the dialog shows the limit error and nothing is created`,
    (await db.order.count({ where: { title: `${PREFIX} over the limit` } })) === 0,
  );
  await B.screenshot("B-desktop-order-limit");
  await B.evaluate(clickDialogButton("Cancel"));
  await A.screenshot("A-390-final");
  await B.screenshot("B-desktop-final");
} catch (error) {
  check("UI check completed", false, error instanceof Error ? error.message : String(error));
  await pageA?.screenshot("A-failure").catch(() => {});
  await pageB?.screenshot("B-failure").catch(() => {});
} finally {
  const ids = [...createdOrderIds];
  const uploads = await db.upload.findMany({ where: { orderId: { in: ids } }, select: { id: true } });
  const deletedUploads = await db.upload.deleteMany({ where: { id: { in: uploads.map((u) => u.id) } } });
  const deletedOrders = await db.order.deleteMany({ where: { id: { in: ids } } });
  console.log(`cleanup: deleted ${deletedOrders.count} orders and ${deletedUploads.count} uploads created by this check`);
  await db.$disconnect();
  pageA?.close();
  pageB?.close();
  for (const child of children.reverse()) stopProcess(child);
  await sleep(500);
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `FAILED ${failed} of ${results.length} checks` : `ALL ${results.length} CHECKS PASSED`);
  process.exitCode = failed ? 1 : 0;
}
