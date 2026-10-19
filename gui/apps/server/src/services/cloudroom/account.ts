import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getProject, type DbConnection } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { cloudroom, configuredWebsite, trustedWebsite } from "./commands.js";
import { cancelGithubLogin } from "./github-login.js";
import { macAccess } from "./previews.js";
import { hasMacCodexLogin } from "./sandboxes.js";
import { copyLogins } from "./sync.js";
import { linkInstall, reportSignInFailed } from "./setup-telemetry.js";

// Keep the loopback listener open while a VM is provisioned. The one-use pairing code expires separately after five minutes.
export const pendingLoginTimeoutMs = 30 * 60_000;
const signInSchema = z.object({ projectId: z.string().min(1).optional(), websiteUrl: z.string().url().optional(), provider: z.enum(["github", "google"]).optional() }).strict();
const handoffSchema = z.object({
  account: z.object({ id: z.string().uuid(), email: z.string().email() }).strict(),
  connection: z.object({ url: z.string().url(), token: z.string().min(32), gateToken: z.string().regex(/^[a-zA-Z0-9._~-]{1,4096}$/).optional() }).strict().optional(),
  sandboxes: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict().refine((handoff) => handoff.connection || handoff.sandboxes, "A VM connection or cloud sandboxes are required.");
type Deps = Pick<AppDeps, "db" | "hub" | "config" | "providerRegistry">;
type Pending = { state: string; verifier: string; origin: URL; callback: string; projectId?: string; abort: AbortController; timer: ReturnType<typeof setTimeout>; claimed: boolean };
type ReturnReply = { status: number; headers: Record<string, string>; html: string };
/** The browser returns here, on this server's own loopback port, after signing in on the website. The website accepts only this path on 127.0.0.1. */
export const RETURN_PATH = "/cloudroom/return";
function signInPort(serverPort: number): number {
  const configured = process.env.CLOUDROOM_SIGNIN_PORT;
  const port = configured === undefined ? serverPort : Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 80) {
    throw new ApiError(503, "cloudroom_signin_unavailable", "Cloudroom sign-in requires a callback port from 1 to 65535 other than 80. Set CLOUDROOM_SIGNIN_PORT to the server port or a port forwarded to it.");
  }
  return port;
}
const accounts = new WeakMap<DbConnection, CloudroomAccountService>();

function callbackPage(success: boolean, message: string, nonce: string): string {
  const title = success ? "You’re signed in" : "Sign-in not completed";
  const escaped = message.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${title} | Cloudroom</title>
<style nonce="${nonce}">
:root{--accent:#bfff00}*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:24px;background:#0a0a0a;color:#fafafa;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:560px;padding:48px;border:1px solid #303030;background:#141414}.brand{color:inherit;text-decoration:none;font-size:28px;font-weight:700;letter-spacing:-1px}.brand span{color:var(--accent)}.brand:focus-visible{outline:2px solid var(--accent);outline-offset:8px}
.status{display:flex;align-items:center;gap:12px;margin:44px 0 24px;color:#b5b5b5;font-size:12px;letter-spacing:1.5px;text-transform:uppercase}.symbol{display:grid;place-items:center;width:36px;height:36px;background:var(--accent);color:#0a0a0a}.symbol svg{width:22px;height:22px}
h1{margin:0 0 20px;font-size:clamp(28px,5vw,40px);font-weight:500;letter-spacing:-1.5px;line-height:1.15}p{margin:0;color:#b5b5b5;font-size:17px;line-height:1.65;overflow-wrap:anywhere}.next{margin-top:32px;padding-top:28px;border-top:1px solid #303030}.next strong{display:block;margin-bottom:8px;font-size:16px;font-weight:500}.next p{font-size:14px}.open{display:flex;align-items:center;justify-content:space-between;gap:16px}.button{flex-shrink:0;padding:12px 18px;background:var(--accent);color:#0a0a0a;font-size:14px;font-weight:700;text-decoration:none}.button:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.local{margin-top:32px;font-size:12px;color:#999}
@media(max-width:480px){main{padding:32px 24px}.status{margin-top:32px}.open{flex-direction:column;align-items:flex-start}}
</style></head><body><main>
<a class="brand" href="https://www.cloudroom.dev">cloudroom<span>.</span></a>
<div class="status"><span class="symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${success ? '<path d="m5 12 4 4L19 6"/>' : '<path d="M12 5v9m0 3v2"/>'}</svg></span>${success ? "Sign-in complete" : "Please try again"}</div>
<h1>${title}</h1><p>${escaped}</p>
${success
    ? '<div class="next open"><div><strong>Head back to Cloudroom</strong><p>Next, connect Claude Code and Codex in the app. You can close this browser tab.</p></div><a class="button" href="cloudroom://open">Open Cloudroom</a></div>'
    : '<div class="next"><strong>Start sign-in again from the Cloudroom app</strong><p>You can close this browser tab.</p></div>'}
<p class="local">This page is served by Cloudroom on your Mac.</p>
</main></body></html>`;
}

export function cloudroomAccount(deps: Deps) {
  let service = accounts.get(deps.db);
  if (!service) { service = new CloudroomAccountService(deps); accounts.set(deps.db, service); }
  return service;
}

export class CloudroomAccountService {
  private pending: Pending | null = null;
  private error: string | null = null;
  constructor(private readonly deps: Deps) {}

  async status() {
    const status = await cloudroom(this.deps).status();
    const macAccessLevel = await macAccess(this.deps);
    let signInCallback: string | undefined;
    let signInError = this.error;
    try { signInCallback = this.pending?.callback ?? this.callbackUrl(); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      signInError = error.message;
    }
    return { ...status, macAccess: macAccessLevel === null ? null : macAccessLevel !== "off", macAccessLevel, copyLogins: await copyLogins(this.deps), localLogins: { codex: await hasMacCodexLogin() }, signingIn: this.pending !== null, signInError, signInCallback };
  }


  cancel(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.abort.abort();
    }
    this.error = null;
  }

  async logout(): Promise<void> {
    this.cancel();
    cancelGithubLogin();
    await cloudroom(this.deps).disconnect();
  }

  /** Where the browser lands after the website sign-in: this server's own loopback port by default. CLOUDROOM_SIGNIN_PORT names another loopback port the browser's machine relays here (a tunnel or proxy) when Cloudroom runs elsewhere. */
  callbackUrl(): string {
    return `http://127.0.0.1:${signInPort(this.deps.config.serverPort)}${RETURN_PATH}`;
  }

  async signIn(raw: unknown): Promise<{ url: string; callback: string }> {
    const input = signInSchema.parse(raw);
    if (input.projectId && !getProject(this.deps.db, input.projectId)) throw new ApiError(404, "project_not_found", "Project not found.");
    const origin = new URL(input.websiteUrl ?? configuredWebsite());
    if (origin.href !== `${origin.origin}/` || !trustedWebsite(origin.origin)) throw new ApiError(400, "invalid_request", "Use the Cloudroom website or an explicit loopback development server.");
    const callback = this.callbackUrl();
    this.cancel();
    const state = randomBytes(32).toString("hex");
    const verifier = randomBytes(32).toString("hex");
    const challenge = createHash("sha256").update(verifier).digest("hex");
    const pending: Pending = { state, verifier, origin, callback, projectId: input.projectId, abort: new AbortController(), timer: setTimeout(() => {}, 0), claimed: false };
    pending.timer = setTimeout(() => { if (this.pending === pending) { this.cancel(); this.error = "Sign-in expired. Try again."; reportSignInFailed(this.error); } }, pendingLoginTimeoutMs);
    pending.timer.unref();
    this.pending = pending;
    return { url: `${origin.origin}/desktop?${new URLSearchParams({ callback, state, challenge, ...(input.provider ? { provider: input.provider } : {})})}`, callback };
  }

  /** Handles the browser's return from the website. A plain GET navigation: Safari warns when an https page posts a form to http, even 127.0.0.1. The state and verifier still bind it to this app. */
  async handleReturn(request: { method: string; url: string; host: string | undefined }): Promise<ReturnReply> {
    const reply = (status: number, message: string): ReturnReply => {
      const nonce = randomBytes(16).toString("hex");
      return {
        status,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` },
        html: callbackPage(status === 200, message, nonce),
      };
    };
    const url = new URL(request.url, "http://127.0.0.1");
    const pending = this.pending;
    if (request.method !== "GET" || url.pathname !== RETURN_PATH || `${url.pathname}${url.search}`.length > 512) return reply(400, "Invalid sign-in callback. Return to Cloudroom.");
    if (!pending) return reply(400, "Sign-in expired or did not match this app.");
    if (request.host !== new URL(pending.callback).host) return reply(400, "Invalid sign-in callback. Return to Cloudroom.");
    let claimed = false;
    try {
      const receivedState = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      if (!pending || pending.claimed || !/^[a-f0-9]{64}$/.test(receivedState) || !timingSafeEqual(Buffer.from(receivedState), Buffer.from(pending.state)) || !/^[a-f0-9]{64}$/.test(code)) return reply(400, "Sign-in expired or did not match this app.");
      pending.claimed = true;
      claimed = true;
      const { origin, abort } = pending;
      const exchanged = await fetch(`${origin.origin}/api/desktop/redeem`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, verifier: pending.verifier }),
        redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
      });
      if (!exchanged.ok) {
        await exchanged.body?.cancel();
        throw new ApiError(503, "cloudroom_signin_failed", exchanged.status === 401 ? "Sign-in expired or was already used. Try again." : "Cloudroom could not verify your account and existing VM. Try again or contact your administrator.");
      }
      const reader = exchanged.body?.getReader();
      if (!reader) throw new Error("Empty handoff");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 16384) throw new Error("Invalid handoff");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const handoff = handoffSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      abort.signal.throwIfAborted();
      await cloudroom(this.deps).configure(handoff.connection ? { ...handoff.connection, projectId: pending.projectId } : null, handoff.account, abort.signal, origin.origin, handoff.sandboxes?.token);
      linkInstall();
      return reply(200, "You’re done here. Everything else happens in the Cloudroom app.");
    } catch (error) {
      if (pending?.abort.signal.aborted) return reply(400, "Sign-in was cancelled. Start again from Cloudroom.");
      this.error = error instanceof ApiError ? error.message : "Sign-in could not complete. Start again from Cloudroom.";
      reportSignInFailed(error instanceof Error ? error.message : String(error));
      return reply(400, this.error);
    } finally {
      if (claimed && pending && this.pending === pending) {
        clearTimeout(pending.timer);
        this.pending = null;
      }
    }
  }
}
