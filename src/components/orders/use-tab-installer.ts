"use client";

import { useCallback, useSyncExternalStore } from "react";

import { DEMO_INSTALLER_IDS, type DemoInstallerId } from "@/lib/claims/installers";

// The demo identity is remembered per browser tab (sessionStorage), so two
// tabs can act as two different installers.
const STORAGE_KEY = "signflow.actingInstaller";
const DEFAULT_INSTALLER = DEMO_INSTALLER_IDS[0];
const listeners = new Set<() => void>();

function read(): DemoInstallerId {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return (DEMO_INSTALLER_IDS as readonly string[]).includes(stored ?? "")
      ? (stored as DemoInstallerId)
      : DEFAULT_INSTALLER;
  } catch {
    return DEFAULT_INSTALLER;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTabInstaller(): [DemoInstallerId, (id: DemoInstallerId) => void] {
  const installer = useSyncExternalStore(subscribe, read, () => DEFAULT_INSTALLER);
  const setInstaller = useCallback((id: DemoInstallerId) => {
    try {
      sessionStorage.setItem(STORAGE_KEY, id);
    } catch {
      // storage unavailable: the choice just won't survive a reload
    }
    for (const listener of listeners) listener();
  }, []);
  return [installer, setInstaller];
}
