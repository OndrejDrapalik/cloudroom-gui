import { z } from "zod";
import type {
  ResolvedSettings,
  SettingsResolution,
} from "../../configuration.js";
import type {
  E2bImage,
  E2bLaunchOptionsStore,
  SandboxPreset,
} from "../../launch-options.js";
import { PROVIDER_ID } from "../../provider-id.js";
import { errorMessage } from "../../error-message.js";
import {
  readE2bMachineResource,
  type E2bMachineResource,
} from "./resource.js";
import {
  createE2bSandboxExecutor,
  type E2bSandboxClient,
  type E2bSandboxClientFactory,
  type E2bSandboxObservation,
} from "./client.js";
import type {
  SandboxBackend,
  SandboxLifecycleContext,
  SandboxOperationContext,
  SandboxResourceContext,
} from "../sandbox-backend.js";

export const e2bMachineInputsSchema = z
  .object({
    preset: z.string().trim().min(1).optional(),
    image: z.string().trim().min(1).optional(),
  })
  .strict();

export type E2bMachineInputs = z.infer<typeof e2bMachineInputsSchema>;

export interface E2bMachineInspection {
  summary: string;
  values: {
    state: "running" | "paused" | "missing";
    expiresAt: number | null;
    template: string;
  };
}

export interface E2bConnectionStatus {
  available: boolean;
  message: string;
}

export interface E2bSandboxBackend extends SandboxBackend<
  E2bMachineInputs,
  E2bMachineResource
> {
  connectionStatus(): Promise<E2bConnectionStatus>;
  debugContext(): Promise<{
    client: E2bSandboxClient;
    settings: ResolvedSettings;
  }>;
  inspect(resource: E2bMachineResource): Promise<E2bMachineInspection>;
  observe(resource: E2bMachineResource): Promise<E2bSandboxObservation | null>;
}

export interface E2bSandboxBackendDeps {
  clientFactory: E2bSandboxClientFactory;
  currentSettings: () => Promise<SettingsResolution>;
  launchOptions: E2bLaunchOptionsStore;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
}

const E2B_API_RETRY_LIMIT = 3;
const E2B_API_RETRY_MS = 1_000;

export const MANAGED_METADATA = { bbProvider: PROVIDER_ID } as const;

function resolveLaunchSelection(
  inputs: E2bMachineInputs,
  options: Awaited<ReturnType<E2bLaunchOptionsStore["get"]>>,
): { preset: SandboxPreset | null; image: E2bImage } {
  const presetName = inputs.preset ?? options.presets[0]?.name;
  const preset =
    presetName === undefined
      ? null
      : (options.presets.find((entry) => entry.name === presetName) ?? null);
  if (presetName !== undefined && preset === null) {
    throw new Error(`The E2B sandbox preset "${presetName}" is not configured.`);
  }
  const imageName = inputs.image ?? options.images[0]?.name;
  const image = options.images.find((entry) => entry.name === imageName);
  if (image === undefined) {
    throw new Error(`The E2B image "${imageName ?? ""}" is not configured.`);
  }
  return { preset, image };
}

export function createE2bSandboxBackend(
  deps: E2bSandboxBackendDeps,
): E2bSandboxBackend {
  let cachedClient: { token: string; client: E2bSandboxClient } | null = null;

  async function requireSettings(): Promise<ResolvedSettings> {
    const resolved = await deps.currentSettings();
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.settings;
  }

  function clientFor(resolved: ResolvedSettings): E2bSandboxClient {
    const token = `${resolved.domain}\n${resolved.apiKey}`;
    if (cachedClient?.token === token) return cachedClient.client;
    cachedClient?.client.close();
    const client = deps.clientFactory({
      apiKey: resolved.apiKey,
      domain: resolved.domain,
    });
    cachedClient = { token, client };
    return client;
  }

  async function retryE2bApi<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        signal.throwIfAborted();
        if (attempt >= E2B_API_RETRY_LIMIT) throw error;
        await deps.sleep(E2B_API_RETRY_MS * attempt);
      }
    }
  }

  async function findSandbox(
    resource: E2bMachineResource,
    resolved: ResolvedSettings,
  ): Promise<E2bSandboxObservation | null> {
    const client = clientFor(resolved);
    const observed = await client.observe(resource.sandboxId);
    if (observed === null && client.accountIdentity() !== resource.accountIdentity) {
      throw new Error(
        "Restore the E2B credentials that created this machine before lifecycle operations",
      );
    }
    return observed;
  }

  async function findByKey(
    client: E2bSandboxClient,
    key: string,
  ): Promise<E2bSandboxObservation | null> {
    for await (const sandbox of client.list({
      ...MANAGED_METADATA,
      bbMachineKey: key,
    })) {
      if (sandbox.metadata.bbDebug !== "true") return sandbox;
    }
    return null;
  }

  return {
    definition: {
      id: PROVIDER_ID,
      displayName: "E2B Sandbox",
      description: "Create a sandbox in your E2B team.",
      environmentDescription: "Create a project checkout in a new E2B sandbox.",
      runtimeName: "E2B",
      icon: "./e2b-logo.svg",
      ephemeral: true,
      inputs: e2bMachineInputsSchema,
    },
    parseInputs(value) {
      return e2bMachineInputsSchema.parse(value);
    },
    parseResource: readE2bMachineResource,
    allocationKey(resource) {
      return resource.key;
    },
    async availability() {
      const resolved = await deps.currentSettings();
      return resolved.ok
        ? { status: "available" }
        : { status: "setup-required", message: resolved.message };
    },
    async validate(inputs) {
      try {
        resolveLaunchSelection(inputs, await deps.launchOptions.get());
        return { action: "accept" };
      } catch (error) {
        return { action: "refuse", message: errorMessage(error) };
      }
    },
    async create(context) {
      const resolved = await requireSettings();
      const client = clientFor(resolved);
      const selection = resolveLaunchSelection(
        context.inputs,
        await deps.launchOptions.get(),
      );
      context.signal.throwIfAborted();
      const selectedImage = selection.image;
      const size =
        selection.preset === null
          ? null
          : {
              cpuCount: selection.preset.cpuCount,
              memoryMiB: selection.preset.memoryMiB,
            };
      context.report.step(
        selectedImage.source === "dockerfile"
          ? `Preparing the ${selectedImage.name} E2B template…`
          : `Using the ${selectedImage.name} E2B template…`,
      );
      if (selectedImage.source === "template" && size !== null) {
        context.report.log(
          `E2B sizes are fixed per template; the ${selection.preset?.name} preset does not apply to ${selectedImage.template}\n`,
        );
      }
      const built =
        selectedImage.source === "template"
          ? { template: selectedImage.template, user: null }
          : await retryE2bApi(
              () =>
                client.ensureTemplate({
                  displayName: selectedImage.name,
                  dockerfile: selectedImage.dockerfile,
                  size,
                  signal: context.signal,
                  report: context.report,
                }),
              context.signal,
            );
      context.signal.throwIfAborted();
      context.report.step("Creating the E2B sandbox…");
      const sandbox = await retryE2bApi(async () => {
        const existing = await findByKey(client, context.key);
        return existing === null
          ? client.create({
              template: built.template,
              user: built.user,
              timeoutMs: resolved.timeoutMs,
              metadata: { ...MANAGED_METADATA, bbMachineKey: context.key },
              pauseOnTimeout: true,
            })
          : client.connect(existing.sandboxId, {
              timeoutMs: resolved.timeoutMs,
              user: built.user,
            });
      }, context.signal);
      context.report.log(
        `E2B sandbox ${sandbox.sandboxId} uses template ${built.template}\n`,
      );
      const resource: E2bMachineResource = {
        key: context.key,
        sandboxId: sandbox.sandboxId,
        state: "running",
        template: built.template,
        user: built.user,
        accountIdentity: client.accountIdentity(),
        domain: resolved.domain,
      };
      await context.checkpoint(resource);
      context.signal.throwIfAborted();
      return { resource, executor: createE2bSandboxExecutor(sandbox) };
    },
    async reconcileCleanup(context: SandboxOperationContext & { key: string }) {
      const resolved = await requireSettings();
      context.signal.throwIfAborted();
      const client = clientFor(resolved);
      for await (const sandbox of client.list({
        ...MANAGED_METADATA,
        bbMachineKey: context.key,
      })) {
        context.signal.throwIfAborted();
        await client.kill(sandbox.sandboxId);
        if ((await client.observe(sandbox.sandboxId)) !== null) {
          throw new Error("The E2B allocation is still present; retry cleanup.");
        }
      }
      context.signal.throwIfAborted();
    },
    async suspend(
      context: SandboxLifecycleContext<E2bMachineResource>,
    ): Promise<E2bMachineResource> {
      const resolved = await requireSettings();
      const observed = await findSandbox(context.resource, resolved);
      if (observed === null) {
        throw new Error(
          "E2B compute is missing. Changes since the last pause are lost; refusing to invent an empty replacement.",
        );
      }
      if (observed.state === "paused") {
        const paused = { ...context.resource, state: "paused" as const };
        if (context.resource.state !== "paused") await context.checkpoint(paused);
        return paused;
      }
      context.report.step("Pausing the E2B sandbox…");
      const pauseStartedAt = deps.now();
      await clientFor(resolved).pause(observed.sandboxId);
      context.report.log(
        `Paused E2B sandbox ${observed.sandboxId} in ${deps.now() - pauseStartedAt} ms`,
      );
      const paused = { ...context.resource, state: "paused" as const };
      await context.checkpoint(paused);
      return paused;
    },
    async resume(context) {
      const resolved = await requireSettings();
      const observed = await findSandbox(context.resource, resolved);
      if (observed === null) {
        throw new Error(
          "E2B compute is missing. Refusing automatic recovery into an empty sandbox.",
        );
      }
      context.report.step(
        observed.state === "paused"
          ? "Resuming the E2B sandbox…"
          : "Reconnecting to the running E2B sandbox…",
      );
      const sandbox = await clientFor(resolved).connect(observed.sandboxId, {
        timeoutMs: resolved.timeoutMs,
        user: context.resource.user,
      });
      context.report.log(`Resumed E2B sandbox ${sandbox.sandboxId}\n`);
      const resource = { ...context.resource, state: "running" as const };
      await context.checkpoint(resource);
      return { resource, executor: createE2bSandboxExecutor(sandbox) };
    },
    async remove(
      context: SandboxResourceContext<E2bMachineResource>,
    ): Promise<void> {
      const resolved = await requireSettings();
      const observed = await findSandbox(context.resource, resolved);
      if (observed !== null) await clientFor(resolved).kill(observed.sandboxId);
    },
    displayName({ hostId }) {
      return `E2B sandbox ${hostId.replace(/[^a-z0-9]/giu, "").slice(-6)}`;
    },
    close() {
      cachedClient?.client.close();
      cachedClient = null;
    },
    async connectionStatus() {
      const resolved = await deps.currentSettings();
      if (!resolved.ok) return { available: false, message: resolved.message };
      try {
        await clientFor(resolved.settings).check();
        return {
          available: true,
          message: `Connected to E2B (${resolved.settings.domain})`,
        };
      } catch (error) {
        return { available: false, message: errorMessage(error) };
      }
    },
    async debugContext() {
      const settings = await requireSettings();
      return { client: clientFor(settings), settings };
    },
    async observe(resource) {
      return findSandbox(resource, await requireSettings());
    },
    async inspect(resource) {
      const observed = await findSandbox(resource, await requireSettings());
      const state = observed?.state ?? "missing";
      return {
        summary:
          state === "missing"
            ? "E2B compute is missing. Changes since the last pause may be lost; automatic recovery is refused."
            : `E2B machine is ${state}.`,
        values: {
          state,
          expiresAt: observed?.expiresAt ?? null,
          template: resource.template,
        },
      };
    },
  };
}
