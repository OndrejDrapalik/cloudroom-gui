const SHELL = "cloudroom-shell";
const ASSETS = "cloudroom-assets";
const API = "cloudroom-api";
const LIVE_API =
  /^\/api\/v1\/(?:system\/version$|search|threads\/[^/]+\/(?:timeline|host-files|events|search))/;
const OFFLINE_HEADERS = ["x-cloudroom-offline", "x-bb-tunnel-offline"];
const MAC_HEADER = "x-cloudroom-mac";
const MAC_KEY = "/__cloudroom-mac";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") event.respondWith(page(request));
  else if (url.pathname.startsWith("/assets/"))
    event.respondWith(asset(request));
  else if (url.pathname.startsWith("/api/v1/") && !LIVE_API.test(url.pathname))
    event.respondWith(api(request));
});

const offline = (response) =>
  OFFLINE_HEADERS.some((name) => response.headers.get(name) === "1");

async function page(request) {
  const shell = await caches.open(SHELL);
  let response;
  try {
    response = await fetch(request);
  } catch {
    return (await shell.match("/")) ?? Response.error();
  }
  if (
    response.ok &&
    (response.headers.get("content-type") ?? "").startsWith("text/html")
  ) {
    const saved = await shell.match("/");
    if (saved?.headers.get("etag") !== response.headers.get("etag"))
      await caches.delete(ASSETS);
    await shell.put("/", response.clone());
    return response;
  }
  return offline(response) ? ((await shell.match("/")) ?? response) : response;
}

async function asset(request) {
  const assets = await caches.open(ASSETS);
  const saved = await assets.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok) await assets.put(request, response.clone());
  return response;
}

async function forMac(response) {
  const mac = response.headers.get(MAC_HEADER) ?? "";
  const shell = await caches.open(SHELL);
  const known = await shell.match(MAC_KEY);
  if ((known ? await known.text() : "") === mac) return;
  await caches.delete(API);
  await shell.put(MAC_KEY, new Response(mac));
}

async function api(request) {
  let response;
  try {
    response = await fetch(request);
  } catch {
    return (await (await caches.open(API)).match(request)) ?? Response.error();
  }
  await forMac(response);
  const saved = await caches.open(API);
  if (response.ok) {
    await saved.put(request, response.clone());
    return response;
  }
  return offline(response)
    ? ((await saved.match(request)) ?? response)
    : response;
}
