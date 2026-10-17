// Your Macs on cloudroom.run: list them and open one in this window (ADR 0184 relay).
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import {
  connectCredentialSchema,
  deriveConnectBaseUrl,
  type ConnectCredential,
} from "@cloudroom/connect-client";

export const RELAY_CREDENTIAL_FILE_NAME = "relay-credential.bin";
const RELAY_HOST = new URL(
  process.env.CLOUDROOM_CONNECT_URL ?? "https://cloudroom.run",
).hostname;
// A Mac that doesn't answer in 5 seconds counts as offline, so the app opens this Mac instead.
const OPEN_TIMEOUT_MS = 5_000;
const LIST_TIMEOUT_MS = 10_000;

const computerSchema = z.object({
  handle: z.string().min(1),
  name: z.string().min(1),
  live: z.boolean(),
  url: z.string().url(),
});
export type Computer = z.infer<typeof computerSchema>;

const listSchema = z.object({
  selfHandle: z.string().min(1),
  computers: z.array(computerSchema),
});
const openSchema = z.object({
  url: z.string().url(),
  cookie: z.object({
    name: z.string().min(1),
    value: z.string().min(1),
    expiresAt: z.number().positive(),
  }),
});

export type ComputersFailure =
  | "no-credential"
  | "unauthorized"
  | "offline"
  | "unavailable";
export type ComputersResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ComputersFailure };

interface CookieStore {
  set(details: {
    url: string;
    name: string;
    value: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: "lax";
    expirationDate: number;
  }): Promise<void>;
}

export function isRelayUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(`.${RELAY_HOST}`);
  } catch {
    return false;
  }
}

/** The name people see in Finder, like "David's MacBook Pro". */
export async function computerName(): Promise<string> {
  if (process.platform === "darwin") {
    const name = await promisify(execFile)(
      "scutil",
      ["--get", "ComputerName"],
      { timeout: 2_000 },
    )
      .then(({ stdout }) => stdout.trim())
      .catch(() => "");
    if (name) return name;
  }
  return hostname().replace(/\.local$/u, "");
}

/** This Mac's cloudroom.run key, from the Connect plugin on the local server. */
export async function fetchRelayCredential(
  localServerUrl: string,
): Promise<ConnectCredential | null> {
  const response = await fetch(
    new URL("/api/v1/plugins/connect/rpc/relayCredential", localServerUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    },
  ).catch(() => null);
  const body: unknown = await response?.json().catch(() => null);
  const parsed = z
    .object({ ok: z.literal(true), result: connectCredentialSchema.nullable() })
    .safeParse(body);
  return parsed.success ? parsed.data.result : null;
}

async function callRelay(
  credential: ConnectCredential,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<ComputersResult<unknown>> {
  try {
    const response = await fetch(
      new URL(path, deriveConnectBaseUrl(credential.serverUrl)),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (response.status === 401) return { ok: false, reason: "unauthorized" };
    if (response.status === 409) return { ok: false, reason: "offline" };
    if (!response.ok) return { ok: false, reason: "unavailable" };
    return { ok: true, value: await response.json() };
  } catch {
    // A timeout means the relay or the Mac is too slow to use right now.
    return { ok: false, reason: "offline" };
  }
}

export async function listComputers(
  credential: ConnectCredential,
  name: string,
): Promise<ComputersResult<z.infer<typeof listSchema>>> {
  const result = await callRelay(
    credential,
    "/api/computers",
    { name },
    LIST_TIMEOUT_MS,
  );
  if (!result.ok)
    return result.reason === "offline"
      ? { ok: false, reason: "unavailable" }
      : result;
  const parsed = listSchema.safeParse(result.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: "unavailable" };
}

/** Signs this app in to another of your Macs and returns the address to load. */
export async function openComputer(
  credential: ConnectCredential,
  handle: string,
  cookies: CookieStore,
): Promise<ComputersResult<string>> {
  const result = await callRelay(
    credential,
    "/api/computers/open",
    { handle },
    OPEN_TIMEOUT_MS,
  );
  if (!result.ok) return result;
  const parsed = openSchema.safeParse(result.value);
  if (!parsed.success) return { ok: false, reason: "unavailable" };
  const { url, cookie } = parsed.data;
  // The relay's __Host- cookie must have no domain, so it stays on that one Mac's address.
  try {
    await cookies.set({
      url,
      name: cookie.name,
      value: cookie.value,
      path: "/",
      secure: url.startsWith("https:"),
      httpOnly: true,
      sameSite: "lax",
      expirationDate: cookie.expiresAt / 1000,
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  return { ok: true, value: url };
}

export type ComputerList = z.infer<typeof listSchema>;

const SYNC_INTERVAL_MS = 10 * 60_000;
// While this Mac stands in for an offline one, check every minute so "Switch back" shows up soon.
const FALLBACK_SYNC_INTERVAL_MS = 60_000;
const MIN_LIST_INTERVAL_MS = 60_000;
// The Connect plugin registers this Mac a few seconds after the server starts.
const STARTUP_RETRY_MS = 5_000;
const STARTUP_RETRIES = 6;

export interface ComputersSync {
  syncNow(): Promise<void>;
  onListRequested(): void;
  onRuntimeReady(): void;
  setFallback(on: boolean): void;
}

export function createComputersSync(args: {
  fetchList: () => Promise<ComputersResult<ComputerList>>;
  onResult: (result: ComputersResult<ComputerList>) => void;
}): ComputersSync {
  let inFlight: Promise<void> | null = null;
  let lastAttemptAt = 0;
  let retries = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const schedule = (ms: number) => {
    clearInterval(timer);
    timer = setInterval(() => void syncNow(), ms);
    timer.unref();
  };

  function syncNow(): Promise<void> {
    inFlight ??= (async () => {
      lastAttemptAt = Date.now();
      const result = await args.fetchList();
      args.onResult(result);
      if (
        result.ok ||
        result.reason === "unauthorized" ||
        retries >= STARTUP_RETRIES
      )
        return;
      retries += 1;
      setTimeout(() => void syncNow(), STARTUP_RETRY_MS).unref();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  schedule(SYNC_INTERVAL_MS);
  return {
    syncNow,
    onListRequested() {
      if (Date.now() - lastAttemptAt >= MIN_LIST_INTERVAL_MS) void syncNow();
    },
    onRuntimeReady() {
      retries = 0;
      void syncNow();
    },
    setFallback(on) {
      schedule(on ? FALLBACK_SYNC_INTERVAL_MS : SYNC_INTERVAL_MS);
    },
  };
}
