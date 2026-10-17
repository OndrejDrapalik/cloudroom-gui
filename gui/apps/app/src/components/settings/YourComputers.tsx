import { useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_ROW_CLASS,
  SettingsBadge,
  SettingsSection,
} from "@/components/ui/settings-section";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";
import { publishBannerHeight } from "@/components/layout/DesktopUpdateBanner";

// Every Mac signed in to your Cloudroom account. Open one to use its projects and threads from this Mac.
// The desktop app lists them and remembers your pick (ADR 0258).
export function YourComputers() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const [opening, setOpening] = useState<string | null>(null);
  const computers = desktopInfo?.computers;
  if (!computers || computers.list.length < 2 || !desktopApi?.openComputer)
    return null;
  const onScreen =
    computers.viewing ??
    computers.list.find((computer) => computer.self)?.handle;
  const open = (handle: string, self: boolean) => {
    setOpening(handle);
    void desktopApi
      .openComputer?.(self ? null : handle)
      .finally(() => setOpening(null));
  };
  return (
    <SettingsSection
      title="Your computers"
      description="Every Mac signed in to this Cloudroom account. Open one to use its projects and threads from here."
      plain
    >
      <div className={SETTINGS_CARD_CLASS}>
        {computers.list.map((computer) => {
          const current = computer.handle === onScreen;
          return (
            <div key={computer.handle} className={SETTINGS_CARD_ROW_CLASS}>
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground",
                  !computer.online && "opacity-55",
                )}
              >
                <Icon name="Laptop" className="size-4" aria-hidden />
              </span>
              <div
                className={cn(
                  "min-w-0 flex-1 space-y-0.5",
                  !computer.online && "opacity-55",
                )}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-foreground">
                    {computer.name}
                  </span>
                  {computer.self && <SettingsBadge>This Mac</SettingsBadge>}
                  {current && !computer.self && (
                    <SettingsBadge>On screen</SettingsBadge>
                  )}
                </div>
                <span className="inline-flex items-center gap-1.5 text-xs text-subtle-foreground/75">
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      computer.online
                        ? "bg-success"
                        : "border border-subtle-foreground/75",
                    )}
                  />
                  {computer.online ? "Online" : "Offline"}
                </span>
              </div>
              {!current && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!computer.online || opening !== null}
                  onClick={() => open(computer.handle, computer.self)}
                >
                  {opening === computer.handle ? "Opening…" : "Open"}
                  <Icon name="ArrowRight" aria-hidden />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}

// Shown while this Mac stands in for your chosen Mac, which didn't answer at launch.
export function ComputerFallbackBanner() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const fallback = desktopInfo?.computers?.fallback;
  const [retrying, setRetrying] = useState(false);
  if (!fallback || !desktopApi?.openComputer) return null;
  const retry = () => {
    setRetrying(true);
    void desktopApi
      .openComputer?.(fallback.handle)
      .finally(() => setRetrying(false));
  };
  return (
    <div
      ref={publishBannerHeight}
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm"
    >
      <Icon
        name="Laptop"
        className="size-4 shrink-0 text-primary"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">
        {fallback.back ? (
          <>
            <strong>{fallback.name} is back.</strong> Switch to keep working
            there.
          </>
        ) : (
          <>
            <strong>{fallback.name} is offline.</strong> You're using this Mac
            until it's back.
          </>
        )}
      </span>
      <Button size="sm" disabled={retrying} onClick={retry}>
        {retrying ? "Opening…" : fallback.back ? "Switch" : "Retry"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void desktopApi.openComputer?.(null)}
      >
        Use this Mac
      </Button>
    </div>
  );
}
