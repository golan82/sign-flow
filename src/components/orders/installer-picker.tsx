"use client";

import { UserRound } from "lucide-react";

import { DEMO_INSTALLERS, type DemoInstallerId } from "@/lib/claims/installers";

export function InstallerPicker({
  value,
  onChange,
}: {
  value: DemoInstallerId;
  onChange: (id: DemoInstallerId) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed bg-background p-3 sm:flex-row sm:items-center sm:gap-3">
      <label htmlFor="acting-installer" className="flex items-center gap-2 text-sm font-medium">
        <UserRound aria-hidden="true" className="size-4 text-muted-foreground" />
        Acting as installer
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide text-amber-900 uppercase dark:bg-amber-950 dark:text-amber-200">
          Demo
        </span>
      </label>
      <select
        id="acting-installer"
        value={value}
        onChange={(event) => onChange(event.target.value as DemoInstallerId)}
        aria-describedby="acting-installer-hint"
        className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-56"
      >
        {DEMO_INSTALLERS.map((installer) => (
          <option key={installer.id} value={installer.id}>
            {installer.name}
          </option>
        ))}
      </select>
      <p id="acting-installer-hint" className="text-xs text-muted-foreground">
        Simulated identity for this browser tab. There is no login.
      </p>
    </div>
  );
}
