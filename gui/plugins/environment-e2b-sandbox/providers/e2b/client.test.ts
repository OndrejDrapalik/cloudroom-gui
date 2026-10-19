import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createE2bSandboxClient,
  createE2bSandboxExecutor,
  shellJoin,
} from "./client.js";

const vendor = vi.hoisted(() => ({
  run: vi.fn(),
  sendStdin: vi.fn(),
  closeStdin: vi.fn(),
  getInfo: vi.fn(),
  connect: vi.fn(),
  create: vi.fn(),
  kill: vi.fn(),
  pause: vi.fn(),
}));

vi.mock("e2b", () => {
  class SandboxNotFoundError extends Error {}
  class NotFoundError extends Error {}
  class CommandExitError extends Error {
    constructor(readonly result: { exitCode: number; stdout: string; stderr: string }) {
      super("exit");
    }
    get exitCode() {
      return this.result.exitCode;
    }
  }
  class Sandbox {
    sandboxId = "sbx-1";
    commands = {
      run: vendor.run,
      sendStdin: vendor.sendStdin,
      closeStdin: vendor.closeStdin,
    };
    static connect = vendor.connect;
    static create = vendor.create;
    static getInfo = vendor.getInfo;
    static kill = vendor.kill;
    static pause = vendor.pause;
    kill = vendor.kill;
    pause = vendor.pause;
  }
  return { Sandbox, SandboxNotFoundError, NotFoundError, CommandExitError };
});

function commandHandle(exitCode: number, chunks: { out?: string[]; err?: string[] }) {
  return {
    pid: 42,
    kill: vi.fn(async () => true),
    wait: vi.fn(async () => {
      const { CommandExitError } = await import("e2b");
      if (exitCode !== 0)
        throw new CommandExitError({ exitCode, stdout: "", stderr: "" });
      return { exitCode, stdout: "", stderr: "" };
    }),
    chunks,
  };
}

beforeEach(() => {
  vendor.run.mockReset();
  vendor.sendStdin.mockReset().mockResolvedValue(undefined);
  vendor.closeStdin.mockReset().mockResolvedValue(undefined);
  vendor.getInfo.mockReset();
  vendor.connect.mockReset();
  vendor.kill.mockReset();
  vendor.pause.mockReset();
});

const credentials = { apiKey: "e2b_test", domain: "e2b.app" };

describe("shellJoin", () => {
  it("quotes only arguments that need it", () => {
    expect(shellJoin(["bb", "machine", "enroll", "--name=x"])).toBe(
      "bb machine enroll --name=x",
    );
    expect(shellJoin(["bash", "-lc", "echo 'hi' && exit 7"])).toBe(
      `bash -lc 'echo '\\''hi'\\'' && exit 7'`,
    );
  });
});

describe("E2B bootstrap executor", () => {
  async function executor() {
    const { Sandbox } = await import("e2b");
    vendor.connect.mockResolvedValue(new Sandbox({} as never));
    const sandbox = await createE2bSandboxClient(credentials).connect("sbx-1");
    return createE2bSandboxExecutor(sandbox);
  }

  it("runs commands as the template user when one is known", async () => {
    vendor.run.mockResolvedValue(commandHandle(0, {}));
    const { Sandbox } = await import("e2b");
    vendor.connect.mockResolvedValue(new Sandbox({} as never));
    const sandbox = await createE2bSandboxClient(credentials).connect("sbx-1", {
      user: "node",
    });
    await sandbox.exec(["id"], { timeoutMs: 1000, signal: new AbortController().signal });
    expect(vendor.run).toHaveBeenCalledWith("id", expect.objectContaining({ user: "node" }));
  });

  it("delivers stdin through the process API, not argv, and closes input", async () => {
    const handle = commandHandle(0, {});
    vendor.run.mockImplementation(async (_cmd: string, opts: { onStdout: (s: string) => void }) => {
      opts.onStdout("output");
      return handle;
    });
    const transport = await executor();
    const onOutput = vi.fn();
    await expect(
      transport.exec({
        onOutput,
        command: ["bb", "machine", "enroll"],
        timeoutMs: 1234,
        signal: new AbortController().signal,
        stdin: "credential-secret",
      }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(vendor.run).toHaveBeenCalledWith(
      "bb machine enroll",
      expect.objectContaining({ background: true, stdin: true, timeoutMs: 1234 }),
    );
    expect(vendor.run.mock.calls[0]?.[0]).not.toContain("credential-secret");
    expect(vendor.sendStdin).toHaveBeenCalledWith(42, "credential-secret");
    expect(vendor.closeStdin).toHaveBeenCalledWith(42);
    expect(onOutput).toHaveBeenCalledWith("output");
  });

  it("returns non-zero exit codes instead of throwing", async () => {
    vendor.run.mockResolvedValue(commandHandle(7, {}));
    const transport = await executor();
    await expect(
      transport.exec({
        onOutput: vi.fn(),
        command: ["false"],
        timeoutMs: 1000,
        signal: new AbortController().signal,
        stdin: "",
      }),
    ).resolves.toEqual({ exitCode: 7 });
    expect(vendor.sendStdin).not.toHaveBeenCalled();
    expect(vendor.closeStdin).toHaveBeenCalledOnce();
  });

  it("kills a command cancelled during startup without sending credentials", async () => {
    const controller = new AbortController();
    const reason = new Error("Launch cancelled");
    const handle = commandHandle(0, {});
    vendor.run.mockImplementation(async () => {
      controller.abort(reason);
      return handle;
    });
    const transport = await executor();

    await expect(
      transport.exec({
        onOutput: vi.fn(),
        command: ["bb", "machine", "enroll"],
        timeoutMs: 1000,
        signal: controller.signal,
        stdin: "credential-secret",
      }),
    ).rejects.toBe(reason);
    expect(handle.kill).toHaveBeenCalledOnce();
    expect(vendor.sendStdin).not.toHaveBeenCalled();
    expect(handle.wait).not.toHaveBeenCalled();
  });

  it("kills a command cancelled while waiting for its result", async () => {
    const controller = new AbortController();
    const reason = new Error("Launch cancelled");
    const handle = commandHandle(0, {});
    handle.wait.mockImplementation(
      () =>
        new Promise((resolve) => {
          handle.kill.mockImplementationOnce(async () => {
            resolve({ exitCode: 143, stdout: "", stderr: "" });
            return true;
          });
          controller.abort(reason);
        }),
    );
    vendor.run.mockResolvedValue(handle);
    const transport = await executor();

    await expect(
      transport.exec({
        onOutput: vi.fn(),
        command: ["sleep", "10"],
        timeoutMs: 1000,
        signal: controller.signal,
        stdin: "",
      }),
    ).rejects.toBe(reason);
    expect(handle.kill).toHaveBeenCalledOnce();
    expect(vendor.closeStdin).toHaveBeenCalledWith(42);
  });

  it("caps captured output per stream with a truncation marker", async () => {
    vendor.run.mockImplementation(async (_cmd: string, opts: { onStdout: (s: string) => void; onStderr: (s: string) => void }) => {
      opts.onStdout("0123456789");
      opts.onStderr("abc");
      return commandHandle(0, {});
    });
    const { Sandbox } = await import("e2b");
    vendor.connect.mockResolvedValue(new Sandbox({} as never));
    const sandbox = await createE2bSandboxClient(credentials).connect("sbx-1");
    await expect(
      sandbox.exec(["cat"], {
        timeoutMs: 1000,
        signal: new AbortController().signal,
        maxOutputBytes: 4,
      }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: "0123\n[output truncated]",
      stderr: "abc",
    });
  });
});

describe("E2B sandbox lookups", () => {
  it("treats a vanished sandbox as absent and hashes credentials into an identity", async () => {
    const { SandboxNotFoundError } = await import("e2b");
    vendor.getInfo.mockRejectedValue(new SandboxNotFoundError("gone"));
    const client = createE2bSandboxClient(credentials);
    await expect(client.observe("sbx-missing")).resolves.toBeNull();
    expect(client.accountIdentity()).toMatch(/^[0-9a-f]{64}$/u);
    expect(client.accountIdentity()).not.toBe(
      createE2bSandboxClient({ ...credentials, domain: "e2b-eu.dev" }).accountIdentity(),
    );
  });

  it("maps vendor info to an observation with expiry only while running", async () => {
    const endAt = new Date("2026-10-18T12:00:00Z");
    vendor.getInfo.mockResolvedValueOnce({
      sandboxId: "sbx-1",
      state: "running",
      endAt,
      metadata: { bbMachineKey: "k" },
    });
    vendor.getInfo.mockResolvedValueOnce({
      sandboxId: "sbx-1",
      state: "paused",
      endAt,
      metadata: {},
    });
    const client = createE2bSandboxClient(credentials);
    await expect(client.observe("sbx-1")).resolves.toEqual({
      sandboxId: "sbx-1",
      state: "running",
      expiresAt: endAt.getTime(),
      metadata: { bbMachineKey: "k" },
    });
    await expect(client.observe("sbx-1")).resolves.toMatchObject({
      state: "paused",
      expiresAt: null,
    });
  });

  it("creates with pause-on-timeout lifecycle and managed metadata", async () => {
    const { Sandbox } = await import("e2b");
    vendor.create.mockResolvedValue(new Sandbox({} as never));
    const client = createE2bSandboxClient(credentials);
    await client.create({
      template: "bb-standard-x",
      user: "node",
      timeoutMs: 60_000,
      metadata: { bbMachineKey: "k" },
      pauseOnTimeout: true,
    });
    expect(vendor.create).toHaveBeenCalledWith("bb-standard-x", {
      apiKey: "e2b_test",
      domain: "e2b.app",
      timeoutMs: 60_000,
      metadata: { bbMachineKey: "k" },
      lifecycle: { onTimeout: "pause" },
    });
  });
});
