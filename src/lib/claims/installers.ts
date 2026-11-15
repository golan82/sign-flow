// Fixed demo installer identities. This is a simulation without login: the
// browser picks one of these ids and the server only checks that it is on
// this list. It is NOT an authentication or authorization mechanism.

export const DEMO_INSTALLERS = [
  { id: "installer-alex", name: "Alex Rivera" },
  { id: "installer-sam", name: "Sam Patel" },
  { id: "installer-jordan", name: "Jordan Lee" },
] as const;

export type DemoInstallerId = (typeof DEMO_INSTALLERS)[number]["id"];

export const DEMO_INSTALLER_IDS = DEMO_INSTALLERS.map((installer) => installer.id) as [
  DemoInstallerId,
  ...DemoInstallerId[],
];

export function getInstallerName(id: string | null): string {
  return DEMO_INSTALLERS.find((installer) => installer.id === id)?.name ?? id ?? "Unknown installer";
}
