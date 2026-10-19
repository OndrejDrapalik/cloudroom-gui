import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderCreateContext,
  PluginMachineProviderProgress,
  PluginMachineProviderResource,
} from "@get-bb/plugin-sdk/machine-provider";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type {
  E2bSandboxClient,
  E2bSandboxCreateRequest,
  E2bSandboxHandle,
  E2bSandboxObservation,
} from "./providers/e2b/client.js";
import { e2bLaunchOptionsSchema } from "./launch-options.js";
import { createE2bSandboxPlugin } from "./server.js";
import { PROVIDER_ID } from "./provider-id.js";

const PLUGIN_ID = "environment-e2b-sandbox";
const HOST_ID = "host_e2b";
const SETTINGS = { apiKey: "e2b_test" };
const SESSION_MS = 60 * 60_000;
const report: PluginMachineProviderProgress = {
  step() {},
  log() {},
};
type Host = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number];

function host(
  status: Host["status"],
  phase: Host["lifecycle"]["phase"] = "active",
): Host {
  return {
    id: HOST_ID,
    name: "E2B sandbox oste2b",
    type: "persistent",
    status,
    machineProviderId: PROVIDER_ID,
    lifecycle: {
      phase,
      suspendedAt: null,
      message: null,
      pendingLog: "",
      teardown: null,
    },
    maxPermissionMode: "full",
    lastSeenAt: null,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

interface FakeSandboxState {
  id: string;
  template: string;
  metadata: Record<string, string>;
  state: "running" | "paused";
  connected: boolean;
  killed: boolean;
  endAt: number;
}

function createVendor(options: { failPauseOnce?: boolean } = {}) {
  const creates: E2bSandboxCreateRequest[] = [];
  const states: FakeSandboxState[] = [];
  const connects: string[] = [];
  let nextSandbox = 0;
  let failPause = options.failPauseOnce === true;
  let identity = "e2b-account";

  const live = (id: string) =>
    states.find((state) => state.id === id && !state.killed);

  function handle(state: FakeSandboxState): E2bSandboxHandle {
    return {
      sandboxId: state.id,
      async exec(command) {
        if (command[0] === "bootstrap-test") state.connected = true;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      async pause() {
        if (failPause) {
          failPause = false;
          throw new Error("pause failed");
        }
        state.state = "paused";
        state.connected = false;
      },
      async kill() {
        state.killed = true;
        state.connected = false;
      },
    };
  }
  const observe = (state: FakeSandboxState): E2bSandboxObservation => ({
    sandboxId: state.id,
    state: state.state,
    expiresAt: state.state === "running" ? state.endAt : null,
    metadata: state.metadata,
  });

  const template = vi.fn(
    async (): Promise<{ template: string; user: string | null }> => ({
      template: "bb-standard-default",
      user: "node",
    }),
  );
  const client: E2bSandboxClient = {
    accountIdentity: () => identity,
    ensureTemplate: template,
    check: async () => {},
    close() {},
    async create(request) {
      creates.push(request);
      nextSandbox += 1;
      const state: FakeSandboxState = {
        id: `sbx-${nextSandbox}`,
        template: request.template,
        metadata: request.metadata,
        state: "running",
        connected: false,
        killed: false,
        endAt: request.timeoutMs,
      };
      states.push(state);
      return handle(state);
    },
    async connect(sandboxId) {
      const state = live(sandboxId);
      if (state === undefined) throw new Error(`sandbox ${sandboxId} not found`);
      connects.push(sandboxId);
      state.state = "running";
      return handle(state);
    },
    async observe(sandboxId) {
      const state = live(sandboxId);
      return state === undefined ? null : observe(state);
    },
    async pause(sandboxId) {
      const state = live(sandboxId);
      if (state === undefined) throw new Error("missing");
      await handle(state).pause();
    },
    async kill(sandboxId) {
      const state = live(sandboxId);
      if (state !== undefined) await handle(state).kill();
    },
    async *list(metadata) {
      for (const state of states) {
        if (state.killed) continue;
        if (
          Object.entries(metadata).every(
            ([key, value]) => state.metadata[key] === value,
          )
        )
          yield observe(state);
      }
    },
  };
  return {
    client,
    template,
    creates,
    states,
    connects,
    setIdentity(value: string) {
      identity = value;
    },
  };
}

async function setup(
  settings: Record<string, string | number> = SETTINGS,
  options: { failPauseOnce?: boolean } = {},
) {
  const vendor = createVendor(options);
  const machineResource = vi.fn(
    async (_hostId: string): Promise<JsonValue | null> => null,
  );
  const hostPhase = { value: "active" as Host["lifecycle"]["phase"] };
  const suspend = vi.fn(async (_input: { hostId: string }) => {});
  const reconcile = vi.fn(async (_input: { hostId: string }) => {});
  const fake = createFakePluginHost({
    pluginId: PLUGIN_ID,
    machineResource,
    settings,
    sdk: {
      hosts: {
        list: async () => [
          host(
            vendor.states.some((state) => state.connected && !state.killed)
              ? "connected"
              : "disconnected",
            hostPhase.value,
          ),
        ],
        get: async () => host("connected", hostPhase.value),
        experimental_suspend: suspend as never,
        experimental_reconcile: reconcile as never,
      },
    },
  });
  const bootstrap = vi.fn(
    async (request: {
      key: string;
      executor: {
        exec(request: {
          command: string[];
          timeoutMs: number;
          signal: AbortSignal;
          stdin?: string;
          onOutput?: (chunk: string) => void;
        }): Promise<{ exitCode: number }>;
      };
      report: PluginMachineProviderProgress;
      signal: AbortSignal;
    }) => {
      await request.executor.exec({
        command: ["bootstrap-test"],
        timeoutMs: 1000,
        signal: request.signal,
        stdin: "bootstrap-secret",
      });
      return { hostId: HOST_ID };
    },
  );
  Object.assign(fake.bb.experimental_machines, { bootstrap });
  const clock = { now: 1_000_000 };
  await createE2bSandboxPlugin({
    clientFactory: (credentials) => ({
      accountIdentity: () =>
        credentials.apiKey === SETTINGS.apiKey
          ? vendor.client.accountIdentity()
          : "changed-account",
      ensureTemplate: (request) => vendor.client.ensureTemplate(request),
      check: () => vendor.client.check(),
      close: () => vendor.client.close(),
      create: (request) => vendor.client.create(request),
      connect: (id, timeoutMs) => vendor.client.connect(id, timeoutMs),
      observe: (id) => vendor.client.observe(id),
      pause: (id) => vendor.client.pause(id),
      kill: (id) => vendor.client.kill(id),
      list: (metadata) => vendor.client.list(metadata),
    }),
    now: () => clock.now,
    sleep: async () => {},
  })(fake.bb);
  const provider = fake.harness.registrations.machineProviders.get(PROVIDER_ID);
  if (provider === undefined)
    throw new Error("machine provider not registered");
  return {
    ...fake,
    machineResource,
    provider,
    vendor,
    bootstrap,
    clock,
    hostPhase,
    suspend,
    reconcile,
  };
}

function createContext(
  key = "e2b-machine-key",
  inputs: JsonValue = {},
): PluginMachineProviderCreateContext {
  return {
    inputs,
    key,
    attempt: 1,
    report,
    signal: new AbortController().signal,
    checkpoint: vi.fn(async (_resource: JsonValue) => {}),
  };
}

function lifecycle(resource: PluginMachineProviderResource) {
  return {
    hostId: HOST_ID,
    resource,
    report,
    signal: new AbortController().signal,
    checkpoint: vi.fn(async (_resource: JsonValue) => {}),
  };
}

describe("E2B machine provider", () => {
  it("reports setup-required without credentials", async () => {
    const harness = await setup({});
    await expect(harness.provider.availability?.()).resolves.toMatchObject({
      status: "setup-required",
      message: "Set apiKey in the plugin's settings.",
    });
  });

  it("creates once by key and recovers the same host", async () => {
    const harness = await setup();
    const log = vi.fn();
    const first = await harness.provider.create({
      ...createContext(),
      report: { step: vi.fn(), log },
    });
    const second = await harness.provider.create(createContext());
    expect(first).toMatchObject({
      status: "created",
      name: "E2B sandbox oste2b",
      resource: {
        key: "e2b-machine-key",
        sandboxId: "sbx-1",
        state: "running",
        template: "bb-standard-default",
        domain: "e2b.app",
      },
    });
    expect(second).toEqual(first);
    expect(harness.vendor.creates).toHaveLength(1);
    expect(harness.vendor.creates[0]).toMatchObject({
      template: "bb-standard-default",
      user: "node",
      timeoutMs: SESSION_MS,
      pauseOnTimeout: true,
      metadata: { bbProvider: PROVIDER_ID, bbMachineKey: "e2b-machine-key" },
    });
    expect(harness.vendor.connects).toEqual(["sbx-1"]);
    expect(harness.bootstrap).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join("")).toContain(
      "E2B sandbox sbx-1 uses template bb-standard-default",
    );
    expect(log.mock.calls.flat().join("")).toMatch(
      /E2B daemon connected in \d+ ms/u,
    );
  });

  it("resolves configured preset and image names for validation and creation", async () => {
    const harness = await setup();
    const current = e2bLaunchOptionsSchema.parse(
      await harness.harness.callRpc("launch.options", {}),
    );
    await harness.harness.callRpc("launch.options.set", {
      presets: [
        { name: "Small", cpuCount: 1, memoryMiB: 512 },
        { name: "Large", cpuCount: 4, memoryMiB: 8192 },
      ],
      images: [
        ...current.images,
        { name: "Ready", source: "template", template: "my-template" },
      ],
    });
    await expect(
      harness.provider.validate?.({ inputs: { preset: "Missing" } }),
    ).resolves.toEqual({
      action: "refuse",
      message: 'The E2B sandbox preset "Missing" is not configured.',
    });
    await expect(
      harness.provider.create(
        createContext("configured-machine", { preset: "Large", image: "Ready" }),
      ),
    ).resolves.toMatchObject({ status: "created" });
    expect(harness.vendor.template).not.toHaveBeenCalled();
    expect(harness.vendor.creates[0]).toMatchObject({
      template: "my-template",
      user: null,
    });

    await expect(
      harness.provider.create(createContext("sized-machine", { preset: "Large" })),
    ).resolves.toMatchObject({ status: "created" });
    expect(harness.vendor.template).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Default",
        size: { cpuCount: 4, memoryMiB: 8192 },
      }),
    );
  });

  it("rejects presets outside E2B's sizing rules", async () => {
    const harness = await setup();
    const current = e2bLaunchOptionsSchema.parse(
      await harness.harness.callRpc("launch.options", {}),
    );
    await expect(
      harness.harness.callRpc("launch.options.set", {
        presets: [{ name: "Odd", cpuCount: 2, memoryMiB: 700 }],
        images: current.images,
      }),
    ).rejects.toThrow();
  });

  it("reuses vendor allocation after bootstrap fails and passes cancellation through", async () => {
    const harness = await setup();
    const context = createContext();
    harness.bootstrap.mockRejectedValueOnce(new Error("connection timed out"));
    await expect(harness.provider.create(context)).resolves.toMatchObject({
      status: "failed",
      message: "connection timed out",
    });
    expect(harness.vendor.states[0]?.killed).toBe(false);
    await expect(harness.provider.create(context)).resolves.toMatchObject({
      status: "created",
    });
    expect(harness.vendor.creates).toHaveLength(1);
    expect(harness.bootstrap).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: context.key, signal: context.signal }),
    );
  });

  it("checkpoints the allocation despite cancellation so core can remove without bootstrap", async () => {
    const test = await setup();
    const controller = new AbortController();
    const create = test.vendor.client.create;
    vi.spyOn(test.vendor.client, "create").mockImplementationOnce(
      async (request) => {
        const sandbox = await create(request);
        controller.abort(new Error("cancelled"));
        return sandbox;
      },
    );
    const checkpoint = vi.fn(async (_resource: JsonValue) => {});
    await expect(
      test.provider.create({
        ...createContext(),
        signal: controller.signal,
        checkpoint,
      }),
    ).rejects.toThrow("cancelled");
    const resource = checkpoint.mock.calls[0]?.[0];
    expect(resource).toMatchObject({
      key: "e2b-machine-key",
      sandboxId: "sbx-1",
      state: "running",
    });
    expect(test.bootstrap).not.toHaveBeenCalled();
    expect(test.vendor.states[0]?.killed).toBe(false);
    if (resource == null) throw new Error("missing checkpoint");
    await test.provider.remove({
      hostId: HOST_ID,
      resource,
      report,
      signal: new AbortController().signal,
    });
    expect(test.vendor.states[0]?.killed).toBe(true);
  });

  it("does not bootstrap or tear down when checkpoint persistence fails", async () => {
    const test = await setup();
    const checkpoint = vi.fn(async (_resource: JsonValue) => {
      throw new Error("checkpoint failed");
    });
    expect(
      await test.provider.create({ ...createContext(), checkpoint }),
    ).toMatchObject({ status: "failed" });
    expect(test.bootstrap).not.toHaveBeenCalled();
    expect(test.vendor.states[0]?.killed).toBe(false);
    expect(await test.provider.create(createContext())).toMatchObject({
      status: "created",
    });
    expect(test.vendor.creates).toHaveLength(1);
  });

  it("cleans every tagged allocation for a key without touching unrelated compute", async () => {
    const test = await setup();
    const context = createContext();
    await test.provider.create(context);
    test.vendor.states.push(
      {
        id: "duplicate",
        template: "t",
        metadata: { bbProvider: PROVIDER_ID, bbMachineKey: context.key },
        state: "paused",
        connected: false,
        killed: false,
        endAt: 0,
      },
      {
        id: "unrelated",
        template: "t",
        metadata: { bbProvider: PROVIDER_ID, bbMachineKey: "other" },
        state: "running",
        connected: false,
        killed: false,
        endAt: 0,
      },
    );
    expect(await test.provider.reconcileCleanup(context)).toEqual({
      status: "removed",
    });
    expect(test.vendor.states.map((state) => state.killed)).toEqual([
      true,
      true,
      false,
    ]);
    expect(await test.provider.reconcileCleanup(context)).toEqual({
      status: "removed",
    });
    expect(test.bootstrap).toHaveBeenCalledOnce();
  });

  it("keeps cleanup retryable while a kill does not take effect", async () => {
    const test = await setup();
    const context = createContext();
    await test.provider.create(context);
    vi.spyOn(test.vendor.client, "kill").mockResolvedValueOnce(undefined);
    expect(await test.provider.reconcileCleanup(context)).toMatchObject({
      status: "failed",
      message: "The E2B allocation is still present; retry cleanup.",
    });
    expect(await test.provider.reconcileCleanup(context)).toEqual({
      status: "removed",
    });
    expect(test.vendor.states[0]?.killed).toBe(true);
  });

  it("pauses in place on suspend, reconnects on resume, and kills on remove", async () => {
    const harness = await setup();
    const created = await harness.provider.create(createContext());
    if (created.status !== "created") throw new Error(created.message);
    const context = lifecycle(created.resource);
    const suspended = await harness.provider.suspend?.(context);
    expect(suspended?.resource).toMatchObject({
      sandboxId: "sbx-1",
      state: "paused",
    });
    expect(harness.vendor.states[0]?.state).toBe("paused");
    if (suspended === undefined) throw new Error("suspend not registered");

    const resumed = await harness.provider.resume?.({
      ...context,
      resource: suspended.resource,
    });
    expect(resumed?.resource).toMatchObject({
      sandboxId: "sbx-1",
      state: "running",
    });
    expect(harness.vendor.creates).toHaveLength(1);
    expect(harness.vendor.connects).toEqual(["sbx-1"]);
    expect(harness.vendor.states[0]).toMatchObject({
      state: "running",
      connected: true,
    });
    expect(harness.bootstrap).toHaveBeenLastCalledWith({
      key: "e2b-machine-key",
      executor: { exec: expect.any(Function) },
      report,
      signal: context.signal,
    });
    if (resumed === undefined) throw new Error("resume not registered");
    await expect(
      harness.provider.remove({ ...context, resource: resumed.resource }),
    ).resolves.toEqual({ status: "removed" });
    expect(harness.vendor.states[0]?.killed).toBe(true);
    await expect(
      harness.provider.remove({ ...context, resource: resumed.resource }),
    ).resolves.toEqual({ status: "removed" });
  });

  it("awaits the resume checkpoint before bootstrap and recovers without allocating again", async () => {
    const harness = await setup();
    const created = await harness.provider.create(createContext());
    if (created.status !== "created") throw new Error(created.message);
    const context = lifecycle(created.resource);
    const suspended = await harness.provider.suspend?.(context);
    if (suspended === undefined) throw new Error("suspend missing");
    harness.bootstrap.mockClear();
    let persisted: JsonValue | null = null;
    await expect(
      harness.provider.resume?.({
        ...context,
        resource: suspended.resource,
        checkpoint: async (resource) => {
          persisted = resource;
          throw new Error("crash after durable checkpoint");
        },
      }),
    ).rejects.toThrow("crash after durable checkpoint");
    expect(harness.bootstrap).not.toHaveBeenCalled();
    if (persisted === null) throw new Error("checkpoint missing");
    expect(persisted).toMatchObject({ sandboxId: "sbx-1", state: "running" });
    await expect(
      harness.provider.resume?.({ ...context, resource: persisted }),
    ).resolves.toMatchObject({ resource: { state: "running" } });
    expect(harness.vendor.creates).toHaveLength(1);
    expect(harness.bootstrap).toHaveBeenCalledOnce();
  });

  it("treats suspend as idempotent when E2B already paused the sandbox", async () => {
    const harness = await setup();
    const created = await harness.provider.create(createContext());
    if (created.status !== "created") throw new Error(created.message);
    harness.vendor.states[0]!.state = "paused";
    const pause = vi.spyOn(harness.vendor.client, "pause");
    const context = lifecycle(created.resource);
    const suspended = await harness.provider.suspend?.(context);
    expect(suspended?.resource).toMatchObject({ state: "paused" });
    expect(pause).not.toHaveBeenCalled();
    expect(context.checkpoint).toHaveBeenCalledOnce();
    await expect(
      harness.provider.suspend?.({ ...context, resource: suspended!.resource }),
    ).resolves.toEqual({ resource: suspended!.resource });
  });

  it("leaves compute running when pausing fails so resume can reconnect", async () => {
    const harness = await setup(SETTINGS, { failPauseOnce: true });
    const created = await harness.provider.create(createContext());
    if (created.status !== "created") throw new Error(created.message);
    const context = lifecycle(created.resource);
    await expect(harness.provider.suspend?.(context)).rejects.toThrow(
      "pause failed",
    );
    expect(harness.vendor.states[0]).toMatchObject({
      state: "running",
      killed: false,
    });
    await expect(harness.provider.resume?.(context)).resolves.toMatchObject({
      resource: { sandboxId: "sbx-1", state: "running" },
    });
  });

  it("refuses to replace missing compute with an empty sandbox", async () => {
    const harness = await setup();
    const created = await harness.provider.create(createContext());
    if (created.status !== "created") throw new Error(created.message);
    harness.vendor.states[0]!.killed = true;
    const context = lifecycle(created.resource);
    await expect(harness.provider.resume?.(context)).rejects.toThrow(
      "E2B compute is missing",
    );
    await expect(harness.provider.suspend?.(context)).rejects.toThrow(
      "E2B compute is missing",
    );
    expect(harness.vendor.creates).toHaveLength(1);
    await expect(harness.provider.remove(context)).resolves.toEqual({
      status: "removed",
    });
  });
});

it("reports bootstrap failures after preserving the allocation", async () => {
  const test = await setup();
  test.bootstrap.mockRejectedValueOnce(new Error("Configure machine access"));
  expect(await test.provider.create(createContext())).toMatchObject({
    status: "failed",
  });
  expect(test.vendor.template).toHaveBeenCalledOnce();
  expect(test.vendor.creates).toHaveLength(1);
});

it("observes vendor state and deadlines", async () => {
  const harness = await setup();
  const created = await harness.provider.create(createContext());
  if (created.status !== "created") throw new Error("creation failed");
  harness.machineResource.mockImplementation(async (hostId) =>
    hostId === HOST_ID ? created.resource : null,
  );
  expect(
    await harness.harness.callRpc("machine.inspect", { hostId: HOST_ID }),
  ).toMatchObject({
    summary: "E2B machine is running.",
    values: {
      state: "running",
      expiresAt: SESSION_MS,
      template: "bb-standard-default",
    },
  });
  harness.vendor.states[0]!.state = "paused";
  expect(
    await harness.harness.callRpc("machine.inspect", { hostId: HOST_ID }),
  ).toMatchObject({ values: { state: "paused", expiresAt: null } });
  harness.vendor.states[0]!.killed = true;
  expect(
    await harness.harness.callRpc("machine.inspect", { hostId: HOST_ID }),
  ).toMatchObject({ values: { state: "missing" } });
});

it("blocks lifecycle operations under foreign credentials unless they reach the sandbox", async () => {
  const harness = await setup();
  const created = await harness.provider.create(createContext());
  if (created.status !== "created") throw new Error("creation failed");
  harness.machineResource.mockImplementation(async (hostId) =>
    hostId === HOST_ID ? created.resource : null,
  );
  await harness.harness.setSettings({ apiKey: "e2b_rotated" });
  const context = lifecycle(created.resource);
  await expect(harness.provider.resume?.(context)).resolves.toMatchObject({
    resource: { sandboxId: "sbx-1" },
  });
  harness.vendor.states[0]!.killed = true;
  await expect(
    harness.harness.callRpc("machine.inspect", { hostId: HOST_ID }),
  ).rejects.toThrow("Restore the E2B credentials that created this machine");
  await expect(harness.provider.resume?.(context)).rejects.toThrow(
    "Restore the E2B credentials",
  );
  await expect(harness.provider.remove(context)).resolves.toMatchObject({
    status: "failed",
    message: expect.stringContaining("Restore the E2B credentials"),
  });
  expect(harness.vendor.creates).toHaveLength(1);
});

it("retries a template build failure inside one create call", async () => {
  const test = await setup();
  test.vendor.template.mockRejectedValueOnce(new Error("template build failed"));
  expect(await test.provider.create(createContext())).toMatchObject({
    status: "created",
  });
  expect(test.vendor.template).toHaveBeenCalledTimes(2);
});

it("does not allocate a sandbox when cancelled during template preparation", async () => {
  const test = await setup();
  const controller = new AbortController();
  test.vendor.template.mockImplementationOnce(async () => {
    controller.abort(new Error("cancelled"));
    return { template: "bb-standard-default", user: null };
  });
  await expect(
    test.provider.create({ ...createContext(), signal: controller.signal }),
  ).rejects.toThrow("cancelled");
  expect(test.vendor.creates).toHaveLength(0);
});

it("validates and persists a Dockerfile override used by new machines, then resets it", async () => {
  const test = await setup();
  const initial = (await test.harness.callRpc("image.definition", {})) as {
    dockerfile: string;
    customized: boolean;
  };
  expect(initial.customized).toBe(false);
  await expect(
    test.harness.callRpc("image.set", { dockerfile: "COPY . /app\n" }),
  ).rejects.toThrow(/requires one FROM/u);
  const override = "FROM debian:bookworm-slim\nRUN apt-get update\n";
  expect(await test.harness.callRpc("image.set", { dockerfile: override })).toEqual({
    dockerfile: override,
    customized: true,
  });
  await test.provider.create(createContext());
  expect(test.vendor.template).toHaveBeenCalledWith(
    expect.objectContaining({ dockerfile: override, size: null }),
  );
  expect(await test.harness.callRpc("image.reset", {})).toEqual(initial);
});

describe("debug sandboxes", () => {
  it("builds without enrollment and runs a bounded debug sandbox with no runtime secrets", async () => {
    const test = await setup();
    expect(await test.harness.callRpc("image.build", {})).toMatchObject({
      template: "bb-standard-default",
    });
    const run = (await test.harness.callRpc("sandbox.run", {})) as {
      sandboxId: string;
      expiresAt: number;
    };
    expect(run.sandboxId).toBe("sbx-1");
    expect(test.vendor.creates[0]).toMatchObject({
      timeoutMs: 30 * 60_000,
      pauseOnTimeout: false,
      metadata: { bbProvider: PROVIDER_ID, bbDebug: "true" },
    });
    expect(test.bootstrap).not.toHaveBeenCalled();
    expect(JSON.stringify(test.vendor.creates)).not.toContain("e2b_test");
  });

  it("preserves command argv, output and exit codes while preventing access to unrelated sandboxes", async () => {
    const test = await setup();
    const run = (await test.harness.callRpc("sandbox.run", {})) as {
      sandboxId: string;
    };
    await expect(
      test.harness.callRpc("sandbox.exec", {
        sandboxId: run.sandboxId,
        command: ["bash", "-lc", "exit 7"],
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    const machine = await test.provider.create(createContext());
    if (machine.status !== "created") throw new Error(machine.message);
    await expect(
      test.harness.callRpc("sandbox.exec", {
        sandboxId: "sbx-2",
        command: ["id"],
      }),
    ).rejects.toThrow("Unknown debug sandbox");
    const cli = await test.harness.behavior.runCli([
      "sandbox",
      "exec",
      run.sandboxId,
      "--json",
      "--",
      "bash",
      "-lc",
      "exit 7",
    ]);
    expect(cli).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(cli.stdout ?? "")).toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
  });

  it("stops debug compute and refuses commands after it is gone", async () => {
    const test = await setup();
    const { sandboxId } = (await test.harness.callRpc("sandbox.run", {})) as {
      sandboxId: string;
    };
    const run = { sandboxId };
    expect(await test.harness.callRpc("sandbox.stop", run)).toEqual(run);
    expect(test.vendor.states[0]?.killed).toBe(true);
    expect(await test.harness.callRpc("sandbox.stop", run)).toEqual(run);
    await expect(
      test.harness.callRpc("sandbox.exec", { ...run, command: ["id"] }),
    ).rejects.toThrow("stopped or expired");
  });

  it("does not allocate debug compute when the template fails to build", async () => {
    const test = await setup();
    test.vendor.template.mockRejectedValueOnce(new Error("build failed"));
    await expect(test.harness.callRpc("sandbox.run", {})).rejects.toThrow(
      "build failed",
    );
    expect(test.vendor.creates).toHaveLength(0);
  });
});

describe("plugin-owned idle timing and reconciliation", () => {
  it("pauses an idle machine after the configured period", async () => {
    const test = await setup({ ...SETTINGS, idleMinutes: 2 });
    const created = await test.provider.create(createContext());
    if (created.status !== "created") throw new Error(created.message);
    test.machineResource.mockResolvedValue(created.resource);
    await test.harness.behavior.runSchedule("pause-idle-machines");
    expect(test.suspend).not.toHaveBeenCalled();
    test.clock.now += 3 * 60_000;
    await test.harness.behavior.runSchedule("pause-idle-machines");
    expect(test.suspend).toHaveBeenCalledWith({ hostId: HOST_ID });
  });

  it("suspends through core when E2B paused the sandbox on its own, and reconciles the reverse", async () => {
    const test = await setup({ ...SETTINGS, idleMinutes: 0 });
    const created = await test.provider.create(createContext());
    if (created.status !== "created") throw new Error(created.message);
    test.machineResource.mockResolvedValue(created.resource);
    test.vendor.states[0]!.state = "paused";
    await test.harness.behavior.runSchedule("pause-idle-machines");
    expect(test.suspend).toHaveBeenCalledWith({ hostId: HOST_ID });
    expect(test.reconcile).not.toHaveBeenCalled();

    test.suspend.mockClear();
    test.hostPhase.value = "suspended";
    test.vendor.states[0]!.state = "running";
    await test.harness.behavior.runSchedule("pause-idle-machines");
    expect(test.reconcile).toHaveBeenCalledWith({ hostId: HOST_ID });
    expect(test.suspend).not.toHaveBeenCalled();
  });

  it("reports account connectivity through RPC and CLI", async () => {
    const test = await setup();
    await expect(test.harness.callRpc("account.inspect", {})).resolves.toEqual({
      available: true,
      message: "Connected to E2B (e2b.app)",
    });
    vi.spyOn(test.vendor.client, "check").mockRejectedValueOnce(
      new Error("401 unauthorized"),
    );
    expect(await test.harness.behavior.runCli(["account", "inspect"])).toMatchObject(
      { exitCode: 1, stdout: "401 unauthorized" },
    );
  });
});
