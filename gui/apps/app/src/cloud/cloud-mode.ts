export const isPhoneRelay = () =>
  window.location.hostname.endsWith(".cloudroom.run");

export const isPhoneApp = () => window.location.hostname === "app.cloudroom.run";

export async function openMacOnPhone(handle: string): Promise<void> {
  const response = await fetch("/__mac", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  if (!response.ok) throw new Error("Couldn't open that Mac.");
  window.location.reload();
}

export async function macOffline(timeoutMs = 4000): Promise<boolean> {
  const response = await fetch("/api/v1/system/version", {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  return (
    response?.status === 503 &&
    response.headers.get("x-bb-tunnel-offline") === "1"
  );
}

export function keepOfflineCopy(): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker
    .register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then(async () => {
      await (
        await caches.open("cloudroom-shell")
      )
        .add("/")
        .catch(() => undefined);
      const files = performance
        .getEntriesByType("resource")
        .map((entry) => new URL(entry.name))
        .filter(
          (url) =>
            url.origin === window.location.origin &&
            url.pathname.startsWith("/assets/"),
        )
        .map((url) => url.href);
      await (
        await caches.open("cloudroom-assets")
      )
        .addAll(files)
        .catch(() => undefined);
    })
    .catch(() => undefined);
}

export function reloadWhenMacGoesOffline(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void macOffline().then((offline) => {
      if (offline) window.location.reload();
    });
  });
}
