import { serveWithCache } from "./cache.js";
import { codePage, messagePage, offlinePage } from "./pages.js";
import {
  GATE_AUTH_HEADER,
  GATE_MACHINE_ID_HEADER,
  MACHINE_CREDENTIAL_HEADER,
  PHONE_SESSION_HEADER,
  SESSION_COOKIE,
  TUNNEL_SESSION_HEADER,
  TUNNEL_TARGET_HEADER,
} from "./protocol-headers.js";
import {
  DESKTOP_SESSION_TTL_MS,
  PHONE_CODE_TTL_MS,
  SESSION_TTL_MS,
  SHARE_CODE_TTL_MS,
  accountServers,
  codeHandle,
  consumeCode,
  createCode,
  createSession,
  formatCode,
  normalizeCode,
  phoneUser,
  registerServer,
  revokeSessions,
  serverByCredential,
  serverByHandle,
  sessionByToken,
  setServerName,
  sha256Hex,
  type Server,
  type Session,
} from "./store.js";
import { TUNNEL_OFFLINE_HEADER, TunnelDO, type Env } from "./tunnel-do.js";

export { TunnelDO };

const WRONG_CODE = "That code is wrong or expired. Get a new one in the Cloudroom desktop app.";
const PORT = /^[1-9][0-9]{0,4}$/;
const CLOUD_PATH = /^\/__cloud\/([a-z0-9_/-]{1,200})$/;
const TOKEN = /^[a-f0-9]{64}$/;
const HANDLE = /^[a-z0-9]{1,63}$/;
const PUBLIC_APP_FILES =
  /^\/(?:manifest[\w-]*\.webmanifest|apple-touch-icon[\w-]*\.png|icon-[\w-]+\.png|favicon[\w.-]*)$/;

interface Visitor {
  handle: string;
  target: string | null;
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function computerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) || null;
}

/** Asks the Mac's tunnel object, so it's right the moment a Mac sleeps or wakes. */
async function isOnline(env: Env, handle: string): Promise<boolean> {
  const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(handle));
  const status = await stub
    .fetch(new Request(`https://${handle}.${env.BASE_DOMAIN}/__control/status`))
    .then((response) => response.json() as Promise<{ online?: unknown }>)
    .catch(() => null);
  return status?.online === true;
}

/** Your Macs, for switching between them (signed in to the same Cloudroom account). Also saves the caller's name. */
async function computers(request: Request, env: Env, self: Server): Promise<Response> {
  const name = computerName((await readJson(request)).name);
  if (name !== null && name !== self.name) await setServerName(env.DB, self.id, name).catch(() => {});
  const servers = await accountServers(env.DB, self.userId);
  return json({
    selfHandle: self.handle,
    computers: await Promise.all(
      servers.map(async (server) => ({
        handle: server.handle,
        name: (server.id === self.id ? name : null) ?? server.name ?? "Mac",
        live: server.id === self.id || (await isOnline(env, server.handle)),
        url: `https://${server.handle}.${env.BASE_DOMAIN}`,
      })),
    ),
  });
}

/** Signs the caller in to another Mac on the same account. The desktop app installs the cookie and opens the Mac. */
async function openComputer(request: Request, env: Env, self: Server): Promise<Response> {
  const handle = (await readJson(request)).handle;
  const target = typeof handle === "string" && HANDLE.test(handle) ? await serverByHandle(env.DB, handle, true) : null;
  if (!target || target.userId !== self.userId || target.id === self.id) {
    return json({ error: "That Mac is not on your account." }, 404);
  }
  if (!(await isOnline(env, target.handle))) return json({ error: "That Mac is offline.", offline: true }, 409);
  const origin = `https://${target.handle}.${env.BASE_DOMAIN}`;
  const expiresAt = Date.now() + DESKTOP_SESSION_TTL_MS;
  const value = await createSession(env.DB, target.id, null, DESKTOP_SESSION_TTL_MS);
  return json({ url: origin, cookie: { name: SESSION_COOKIE, value, expiresAt } });
}

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function bearer(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

export function parseVisitorHost(host: string, baseDomain: string): Visitor | null {
  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) return null;
  const [handle, target, extra] = host.slice(0, -suffix.length).split("--");
  if (!handle || !HANDLE.test(handle) || extra !== undefined) return null;
  if (target === undefined) return { handle, target: null };
  return PORT.test(target) && Number(target) <= 65535 ? { handle, target } : null;
}

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

export function requestForTunnelDo(request: Request, target: string | null): Request {
  const headers = new Headers(request.headers);
  for (const name of [
    TUNNEL_TARGET_HEADER,
    TUNNEL_SESSION_HEADER,
    MACHINE_CREDENTIAL_HEADER,
    GATE_AUTH_HEADER,
    GATE_MACHINE_ID_HEADER,
  ]) {
    headers.delete(name);
  }
  const cookie = (headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${SESSION_COOKIE}=`))
    .join("; ");
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  if (target !== null) headers.set(TUNNEL_TARGET_HEADER, target);
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && token) {
    headers.set(TUNNEL_SESSION_HEADER, token);
  }
  headers.set(GATE_AUTH_HEADER, "session");
  return new Request(request, { headers });
}

export function safeReturnPath(value: string | null): string {
  return value && /^\/(?![/\\])/.test(value) ? value : "/";
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

async function register(request: Request, env: Env): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Basic [A-Za-z0-9+/=]{1,2048}$/.test(authorization)) {
    return json({ error: "Sign in to Cloudroom first." }, 401);
  }
  const body = (await request.json().catch(() => null)) as { installId?: unknown } | null;
  const installId = body?.installId;
  if (typeof installId !== "string" || !/^[a-f0-9]{32}$/.test(installId)) {
    return json({ error: "Invalid install ID." }, 400);
  }
  const verified = await fetch(`${env.WEBSITE_URL}/api/desktop/connect`, {
    method: "POST",
    headers: { authorization },
    redirect: "manual",
  }).catch(() => null);
  if (verified?.status === 401 || verified?.status === 403) {
    return json({ error: "Cloudroom rejected this Mac's sign-in." }, 401);
  }
  const userId = verified?.ok
    ? ((await verified.json().catch(() => null)) as { userId?: unknown } | null)?.userId
    : undefined;
  if (typeof userId !== "string" || !userId) {
    return json({ error: "Cloudroom could not verify this Mac. Try again soon." }, 503);
  }
  const { handle, credential } = await registerServer(env.DB, userId, installId);
  return json({ handle, credential, serverUrl: `https://${handle}.${env.BASE_DOMAIN}` });
}

async function cloud(request: Request, path: string, url: URL, env: Env, token: string): Promise<Response> {
  const headers = new Headers({ [PHONE_SESSION_HEADER]: token });
  for (const name of ["accept", "content-type"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  if (hasBody && request.headers.get("origin") !== url.origin) return json({ error: "Wrong origin." }, 403);
  const response = await fetch(new URL(`/api/connect/cloud/${path}${url.search}`, env.WEBSITE_URL), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
  }).catch(() => null);
  return response ?? json({ error: "Cloudroom is unreachable. Try again." }, 502);
}

async function apex(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method === "POST" && url.pathname === "/api/register") {
    return register(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/phone-session") {
    const token = bearer(request);
    const userId = TOKEN.test(token) ? await phoneUser(env.DB, token) : null;
    return userId ? json({ userId }) : json({ error: "Unknown phone." }, 401);
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/")) {
    const server = await serverByCredential(env.DB, bearer(request));
    if (!server) return json({ error: "Unknown Mac." }, 401);
    if (url.pathname === "/api/computers") return computers(request, env, server);
    if (url.pathname === "/api/computers/open") return openComputer(request, env, server);
    if (url.pathname === "/api/phone-code") {
      const { code, expiresAt } = await createCode(env.DB, server.id, null, PHONE_CODE_TTL_MS);
      const formatted = formatCode(code);
      return json({
        code: formatted,
        expiresAt,
        url: `https://${env.BASE_DOMAIN}/pair?code=${formatted}`,
      });
    }
    if (url.pathname === "/api/phone-sessions/revoke") {
      const revoked = await revokeSessions(env.DB, server.id);
      const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(server.handle));
      const closed = await stub.fetch(
        new Request(
          `https://${server.handle}.${env.BASE_DOMAIN}/__control/revoke-visitors`,
          { method: "POST" },
        ),
      );
      if (!closed.ok) {
        return json({ error: "Could not close phone connections. Try again." }, 503);
      }
      return json({ revoked });
    }
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/pair")) {
    const raw = url.searchParams.get("code");
    if (raw === null) return codePage("/pair", undefined, 200);
    const code = normalizeCode(raw);
    const handle = code === null ? null : await codeHandle(env.DB, code);
    if (code === null || handle === null) return codePage("/pair", WRONG_CODE);
    return redirect(`https://${handle}.${env.BASE_DOMAIN}/__pair?code=${code}`);
  }
  return text("Not found\n", 404);
}

function sessionToken(request: Request): string | null {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  return token && TOKEN.test(token) ? token : null;
}

function serverOrigin(server: Server, target: string | null, env: Env): string {
  return `https://${server.handle}${target === null ? "" : `--${target}`}.${env.BASE_DOMAIN}`;
}

async function visitor(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  { handle, target }: Visitor,
): Promise<Response> {
  const isTunnel = url.pathname === "/__tunnel";
  const server = await serverByHandle(env.DB, handle, isTunnel);
  if (!server) {
    return wantsHtml(request)
      ? messagePage("Not found", "This Cloudroom address does not exist.", 404)
      : text("Not found\n", 404);
  }
  const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(server.handle));

  if (isTunnel) {
    if (target !== null) return text("Not found\n", 404);
    if ((await sha256Hex(bearer(request))) !== server.credentialHash) {
      return text("Invalid credential\n", 401);
    }
    const forward = new URL(request.url);
    forward.searchParams.set("serverId", server.id);
    return stub.fetch(new Request(forward, request));
  }

  if (url.pathname === "/__pair") {
    const code = normalizeCode(url.searchParams.get("code") ?? "");
    if (code === null || !(await consumeCode(env.DB, code, server.id, target))) {
      return target === null
        ? codePage("/__pair", WRONG_CODE)
        : messagePage("Link expired", "Open the link again.", 400);
    }
    const token = await createSession(env.DB, server.id, target);
    return redirect(safeReturnPath(url.searchParams.get("return")), sessionCookie(token));
  }

  const token = sessionToken(request);
  const session: Session | null = token ? await sessionByToken(env.DB, token) : null;
  const signedIn = session?.serverId === server.id && session.target === target;

  const cloudPath = CLOUD_PATH.exec(url.pathname)?.[1];
  if (cloudPath !== undefined) {
    if (!signedIn || target !== null || !token) return json({ error: "Sign in required." }, 401);
    return cloud(request, cloudPath, url, env, token);
  }

  if (url.pathname === "/__share") {
    const port = url.searchParams.get("port") ?? "";
    if (target !== null || !PORT.test(port)) return text("Not found\n", 404);
    if (!signedIn) return codePage("/__pair");
    const { code } = await createCode(env.DB, server.id, port, SHARE_CODE_TTL_MS);
    const next = new URL(`${serverOrigin(server, port, env)}/__pair`);
    next.searchParams.set("code", code);
    next.searchParams.set("return", safeReturnPath(url.searchParams.get("return")));
    return redirect(next.toString());
  }
  if (url.pathname.startsWith("/__")) return text("Not found\n", 404);

  const publicFile =
    target === null && request.method === "GET" && PUBLIC_APP_FILES.test(url.pathname);
  if (!signedIn && !publicFile) {
    if (request.method !== "GET" || !wantsHtml(request)) return text("Sign in required\n", 401);
    if (target === null) return codePage("/__pair");
    const next = new URL(`${serverOrigin(server, null, env)}/__share`);
    next.searchParams.set("port", target);
    next.searchParams.set("return", url.pathname + url.search);
    return redirect(next.toString());
  }

  const doRequest = requestForTunnelDo(request, target);
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return stub.fetch(doRequest);
  }
  const { response } = await serveWithCache(
    request,
    target === null ? server.handle : `${server.handle}--${target}`,
    ctx,
    (init) => {
      if (init === undefined) return stub.fetch(doRequest);
      const headers = new Headers(doRequest.headers);
      headers.set("if-none-match", init.ifNoneMatch);
      return stub.fetch(new Request(doRequest, { headers }));
    },
  );
  if (
    response.status === 503 &&
    response.headers.get(TUNNEL_OFFLINE_HEADER) === "1" &&
    wantsHtml(request)
  ) {
    return offlinePage(server.lastSeenAt);
  }
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    if (host === env.BASE_DOMAIN) return apex(request, url, env);
    const parsed = parseVisitorHost(host, env.BASE_DOMAIN);
    return parsed ? visitor(request, url, env, ctx, parsed) : text("Not found\n", 404);
  },
} satisfies ExportedHandler<Env>;
