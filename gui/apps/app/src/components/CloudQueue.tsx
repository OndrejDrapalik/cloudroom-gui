import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cloudroom/shared-ui/tooltip";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

// The cloud queue (docs/scopes/public-launch.md): Free accounts wait in line to start Cloud threads. Everything else,
// including Local threads, works as usual. The website decides; these only show it.
export type CloudQueue = { position: number; total: number; regionBlocked: boolean };

const upgrade = () => openUrlInExternalBrowser("https://www.cloudroom.dev/billing");

/** Under the new-thread composer while Cloud is picked and the account waits. */
export function CloudQueueCard({ queue, onUseLocal }: { queue: CloudQueue; onUseLocal: () => void }) {
  const local = <Button type="button" size="sm" variant="outline" onClick={onUseLocal}><Icon name="Laptop" aria-hidden />Run it on Local</Button>;
  if (queue.regionBlocked) {
    return (
      <section aria-label="Cloud unavailable" className="mt-3 flex gap-3 rounded-lg border border-foreground/10 bg-surface-raised-solid p-4">
        <Icon name="Cloud" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">Cloud isn't available in your region yet</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">We're adding cloud capacity region by region. Local threads work as usual.</p>
          </div>
          {local}
        </div>
      </section>
    );
  }
  // The share of the line behind you: it fills up as people ahead get in.
  const behind = queue.total > 0 ? Math.max(4, Math.round(((queue.total - queue.position + 1) / queue.total) * 100)) : 4;
  return (
    <section aria-label="Cloud queue" className="mt-3 flex gap-3 rounded-lg border border-foreground/10 bg-surface-raised-solid p-4">
      <Icon name="Cloud" className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">You're in the cloud queue</p>
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">#{queue.position.toLocaleString("en-US")} in line</span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">We let people into the cloud in small batches so it stays fast. We'll tell you here when it's your turn. Local threads work right now.</p>
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-foreground/10"><div className="h-full rounded-full bg-primary" style={{ width: `${behind}%` }} /></div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={upgrade}><Icon name="Zap" aria-hidden />Skip the queue with Pro</Button>
          {local}
          <span className="text-xs text-muted-foreground">Pro is $50/month</span>
        </div>
      </div>
    </section>
  );
}

const share = (used: number, limit: number) => limit > 0 ? Math.min(used / limit, 1) : 1;

/** Free accounts always see their usage. Pro accounts already pay, so theirs shows only once a limit is 80% used. */
export function PlanCard() {
  const usage = useCloudroomAccount().data?.planUsage ?? null;
  if (!usage) return null;
  const pro = usage.plan === "pro";
  const rows = [
    { label: "cloud agents", used: usage.agents, limit: usage.agentsLimit },
    ...(usage.cpuHours === null ? [] : [{ label: "cloud hours", used: usage.cpuHours, limit: usage.cpuHoursLimit }]),
  ];
  if (pro && !rows.some(({ used, limit }) => share(used, limit) >= 0.8)) return null;
  return (
    <section aria-label={pro ? "Pro plan" : "Free plan"} className="rounded-lg border border-border bg-surface-raised-solid p-3">
      <p className="text-xs text-muted-foreground">{pro ? "Pro plan" : "Free plan"}</p>
      {rows.map(({ label, used, limit }) => {
        const low = share(used, limit) >= 0.8;
        return (
          <div key={label} className="mt-2.5">
            <p className="mb-1.5 text-sm text-foreground"><span className={cn("font-semibold", low && "text-warning")}>{Math.max(0, Math.floor(limit - used)).toLocaleString("en-US")}</span> {label} left</p>
            <div className="h-1 overflow-hidden rounded-full bg-foreground/10"><div className={cn("h-full rounded-full", low ? "bg-warning" : "bg-primary")} style={{ width: `${share(used, limit) * 100}%` }} /></div>
          </div>
        );
      })}
      <Button type="button" size="sm" variant={pro ? "outline" : "default"} className="mt-3 w-full" onClick={upgrade}>
        {pro ? "Get 3× more with Super" : "Get 10× more with Pro"}<span className="ml-auto font-normal opacity-70">{pro ? "$150/mo" : "$50/mo"}</span><Icon name="ArrowRight" aria-hidden />
      </Button>
    </section>
  );
}

const PRO_REASONS = [
  "Pro gives you 1,000 cloud agents a month. Free gives you 100.",
  "Pro runs your cloud agents on 2× more powerful sandboxes.",
  "Pro has no daily limit. Free stops at 50 new cloud agents a day.",
  "Pro gives you 300+ hours of agent work every month.",
  "Pro keeps cloud agents awake 4× longer, so they reply faster.",
  "Pro cloud agents never get paused when the cloud gets busy.",
  "Pro keeps your chat history for 1 year. Free keeps 60 days.",
];
let lastReason = Math.floor(Math.random() * PRO_REASONS.length);
const nextReason = () => PRO_REASONS[(lastReason = (lastReason + 1) % PRO_REASONS.length)];

export function FreePlanTip() {
  const usage = useCloudroomAccount().data?.planUsage ?? null;
  const [reason] = useState(nextReason);
  if (usage?.plan !== "free") return null;
  return (
    <p className="mt-3 flex min-w-0 items-center gap-2 px-3.5 text-xs text-muted-foreground">
      <Icon name="Zap" className="size-3.5 shrink-0 text-primary-text" aria-hidden />
      <span className="truncate">{reason}</span>
      <Button type="button" variant="link" size="sm" className="h-auto shrink-0 gap-0.5 p-0 text-xs font-semibold" onClick={upgrade}>
        Upgrade<Icon name="ArrowRight" aria-hidden />
      </Button>
    </p>
  );
}

/** Sidebar footer badge while the account waits. Says so once when the account gets in. */
export function CloudQueueChip() {
  const queue = useCloudroomAccount().data?.cloudQueue ?? null;
  const waited = useRef(false);
  useEffect(() => {
    if (queue && !queue.regionBlocked) waited.current = true;
    else if (!queue && waited.current) {
      waited.current = false;
      appToast.success("You're in! Cloud threads are ready.");
    }
  }, [queue]);
  if (!queue || queue.regionBlocked) return null;
  return (
    <SidebarMenuItem data-footer-item="cloud-queue">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" aria-label={`Cloud queue: number ${queue.position}`} className="h-[26px] gap-1 rounded-md bg-primary/15 px-2 text-xs font-medium text-primary hover:bg-primary/25 hover:text-primary [&_[data-icon-root]]:size-3.5" onClick={upgrade}>
            <Icon name="Cloud" aria-hidden />
            #{queue.position.toLocaleString("en-US")}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">You're #{queue.position.toLocaleString("en-US")} in the cloud queue. Get Pro to skip it.</TooltipContent>
      </Tooltip>
    </SidebarMenuItem>
  );
}
