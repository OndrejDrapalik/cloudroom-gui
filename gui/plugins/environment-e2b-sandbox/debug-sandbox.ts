import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ResolvedSettings } from "./configuration.js";
import type { ImageDefinition } from "./image-definition.js";
import { MANAGED_METADATA } from "./providers/e2b/backend.js";
import type { E2bSandboxClient } from "./providers/e2b/client.js";
import { errorMessage } from "./error-message.js";

const recordSchema = z.object({
  accountIdentity: z.string(),
  domain: z.string(),
  key: z.string(),
});
export const sandboxInput = z.object({ sandboxId: z.string().min(1) }).strict();
export const execInput = sandboxInput.extend({
  command: z.array(z.string().max(65_536)).min(1).max(128),
});
export const buildOutput = z.object({ template: z.string(), logs: z.string() });
export const runOutput = buildOutput.extend({
  sandboxId: z.string(),
  expiresAt: z.number(),
});
export const execOutput = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});

const DEBUG_LIFETIME_MS = 30 * 60_000;

export function debugSandbox(
  bb: BbPluginApi,
  image: ImageDefinition,
  resolve: () => Promise<{
    client: E2bSandboxClient;
    settings: ResolvedSettings;
  }>,
) {
  async function buildWith(
    { client }: Awaited<ReturnType<typeof resolve>>,
    signal: AbortSignal,
  ) {
    let logs = "";
    const append = (line: string) => {
      logs = (logs + line + "\n").slice(-65_536);
    };
    try {
      const built = await client.ensureTemplate({
        displayName: "Default",
        dockerfile: (await image.get()).dockerfile,
        size: null,
        signal,
        report: { step: append, log: append },
      });
      return { template: built.template, user: built.user, logs };
    } catch (error) {
      throw new Error(`${logs}${errorMessage(error)}`);
    }
  }
  async function owned(sandboxId: string) {
    const stored = await bb.storage.kv.get<unknown>(`debug/${sandboxId}`);
    if (stored === undefined)
      throw new Error(
        "Unknown debug sandbox; use an ID returned by room-cli e2b sandbox run",
      );
    const record = recordSchema.parse(stored);
    const { client } = await resolve();
    if (record.accountIdentity !== client.accountIdentity())
      throw new Error("Restore the E2B credentials that created this debug sandbox");
    const observed = await client.observe(sandboxId);
    if (observed?.state !== "running") return null;
    const user = await bb.storage.kv.get<unknown>(`debug/${sandboxId}/user`);
    return client.connect(sandboxId, {
      user: typeof user === "string" ? user : null,
    });
  }
  return {
    async build(signal = new AbortController().signal) {
      return buildWith(await resolve(), signal);
    },
    async run(signal = new AbortController().signal) {
      const resolved = await resolve();
      const { client, settings } = resolved;
      const built = await buildWith(resolved, signal);
      signal.throwIfAborted();
      const key = `bb-debug-${randomUUID()}`;
      const expiresAt = Date.now() + DEBUG_LIFETIME_MS;
      const sandbox = await client.create({
        template: built.template,
        user: built.user,
        timeoutMs: DEBUG_LIFETIME_MS,
        metadata: { ...MANAGED_METADATA, bbDebug: "true", bbMachineKey: key },
        pauseOnTimeout: false,
      });
      try {
        signal.throwIfAborted();
        await bb.storage.kv.set(`debug/${sandbox.sandboxId}`, {
          accountIdentity: client.accountIdentity(),
          domain: settings.domain,
          key,
        });
        signal.throwIfAborted();
        await bb.storage.kv.set(`debug/${sandbox.sandboxId}/user`, built.user);
        return {
          template: built.template,
          logs: built.logs,
          sandboxId: sandbox.sandboxId,
          expiresAt,
        };
      } catch (error) {
        await sandbox.kill();
        throw error;
      }
    },
    async exec(
      input: z.infer<typeof execInput>,
      signal = new AbortController().signal,
    ) {
      const sandbox = await owned(input.sandboxId);
      if (!sandbox)
        throw new Error("Debug sandbox has stopped or expired; run a new sandbox");
      return sandbox.exec(input.command, {
        timeoutMs: 60_000,
        signal,
        maxOutputBytes: 131_072,
      });
    },
    async stop({ sandboxId }: z.infer<typeof sandboxInput>) {
      const sandbox = await owned(sandboxId);
      await sandbox?.kill();
      return { sandboxId };
    },
  };
}
export type DebugSandbox = ReturnType<typeof debugSandbox>;
