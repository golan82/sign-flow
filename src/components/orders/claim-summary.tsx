import { BadgeCheck, Clock, Store } from "lucide-react";

import {
  formatCountdown,
  getClaimRemainingMs,
  getEffectiveClaimState,
  type ClaimDto,
} from "@/lib/claims/claims";
import { getInstallerName } from "@/lib/claims/installers";
import { cn } from "@/lib/utils";

/** One-line claim status for an order row, evaluated against the server clock. */
export function ClaimSummary({
  claim,
  serverNow,
  heldByThisTab,
}: {
  claim: ClaimDto;
  serverNow: number;
  heldByThisTab: boolean;
}) {
  const effective = getEffectiveClaimState(claim, serverNow);
  const name = getInstallerName(claim.installerId);

  const content = {
    AVAILABLE: { icon: Store, tone: "text-muted-foreground", text: "Open for installers" },
    EXPIRED: {
      icon: Store,
      tone: "text-muted-foreground",
      text: `${name}'s claim expired · open for installers`,
    },
    PENDING: {
      icon: Clock,
      tone: "text-amber-700 dark:text-amber-300",
      text: `Claimed by ${name}${heldByThisTab ? " (this tab)" : ""} · awaiting verification · ${formatCountdown(
        getClaimRemainingMs(claim, serverNow),
      )} left`,
    },
    CONFIRMED: {
      icon: BadgeCheck,
      tone: "text-emerald-700 dark:text-emerald-300",
      text: `Installer: ${name} · verified`,
    },
  }[effective];

  const Icon = content.icon;
  return (
    <p className={cn("flex items-center gap-1.5 text-xs font-medium", content.tone)} data-claim-state={effective}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{content.text}</span>
    </p>
  );
}
