import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import {
  CommandExitError,
  NotFoundError,
  Sandbox,
  SandboxNotFoundError,
  type SandboxInfo,
} from "e2b";
import {
  ensureE2bTemplate,
  type E2bTemplateRequest,
  type E2bTemplateResult,
} from "./template.js";

export interface E2bSandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface E2bSandboxHandle {
  readonly sandboxId: string;
  exec(
    command: readonly string[],
    options: {
      timeoutMs: number;
      signal: AbortSignal;
      stdin?: string;
      maxOutputBytes?: number;
      onOutput?: (chunk: string) => void;
    },
  ): Promise<E2bSandboxExecResult>;
  pause(): Promise<void>;
  kill(): Promise<void>;
}

export function createE2bSandboxExecutor(
  sandbox: E2bSandboxHandle,
): MachineExecutor {
  return {
    async exec({ command, ...options }) {
      const { exitCode } = await sandbox.exec(command, {
        ...options,
        maxOutputBytes: 0,
      });
      return { exitCode };
    },
  };
}

export interface E2bSandboxObservation {
  sandboxId: string;
  state: "running" | "paused";
  expiresAt: number | null;
  metadata: Record<string, string>;
}

export interface E2bSandboxCreateRequest {
  template: string;
  user: string | null;
  timeoutMs: number;
  metadata: Record<string, string>;
  pauseOnTimeout: boolean;
}

export interface E2bSandboxClient {
  accountIdentity(): string;
  ensureTemplate(request: E2bTemplateRequest): Promise<E2bTemplateResult>;
  check(): Promise<void>;
  close(): void;
  create(request: E2bSandboxCreateRequest): Promise<E2bSandboxHandle>;
  connect(
    sandboxId: string,
    options?: { timeoutMs?: number; user?: string | null },
  ): Promise<E2bSandboxHandle>;
  observe(sandboxId: string): Promise<E2bSandboxObservation | null>;
  pause(sandboxId: string): Promise<void>;
  kill(sandboxId: string): Promise<void>;
  list(metadata: Record<string, string>): AsyncIterable<E2bSandboxObservation>;
}

export interface E2bCredentials {
  apiKey: string;
  domain: string;
}

export type E2bSandboxClientFactory = (
  credentials: E2bCredentials,
) => E2bSandboxClient;

export function shellJoin(command: readonly string[]): string {
  return command
    .map((argument) =>
      /^[A-Za-z0-9_./:=@%+,-]+$/u.test(argument)
        ? argument
        : `'${argument.replace(/'/gu, `'\\''`)}'`,
    )
    .join(" ");
}

function isNotFound(error: unknown): boolean {
  return error instanceof SandboxNotFoundError || error instanceof NotFoundError;
}

function observation(info: SandboxInfo): E2bSandboxObservation {
  return {
    sandboxId: info.sandboxId,
    state: info.state,
    expiresAt: info.state === "running" ? info.endAt.getTime() : null,
    metadata: info.metadata,
  };
}

function wrapSandbox(sandbox: Sandbox, user: string | null): E2bSandboxHandle {
  return {
    sandboxId: sandbox.sandboxId,
    async exec(command, options) {
      options.signal.throwIfAborted();
      const limit = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
      const sink = () => {
        let size = 0;
        let truncated = false;
        const chunks: Buffer[] = [];
        return {
          push(chunk: string) {
            options.onOutput?.(chunk);
            const data = Buffer.from(chunk);
            const remaining = limit - size;
            if (data.length > remaining) truncated = true;
            if (remaining > 0) {
              const kept = data.subarray(0, Math.min(remaining, data.length));
              chunks.push(kept);
              size += kept.length;
            }
          },
          text: () =>
            Buffer.concat(chunks).toString("utf8") +
            (truncated ? "\n[output truncated]" : ""),
        };
      };
      const stdout = sink();
      const stderr = sink();
      const handle = await sandbox.commands.run(shellJoin(command), {
        background: true,
        stdin: true,
        timeoutMs: options.timeoutMs,
        ...(user === null ? {} : { user }),
        onStdout: (chunk) => stdout.push(chunk),
        onStderr: (chunk) => stderr.push(chunk),
      });
      const onAbort = () => {
        void handle.kill().catch(() => {});
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (options.signal.aborted) onAbort();
        options.signal.throwIfAborted();
        try {
          if (options.stdin !== undefined && options.stdin.length > 0) {
            await sandbox.commands.sendStdin(handle.pid, options.stdin);
          }
        } finally {
          await sandbox.commands.closeStdin(handle.pid).catch(() => {});
        }
        let exitCode: number;
        try {
          exitCode = (await handle.wait()).exitCode;
        } catch (error) {
          if (!(error instanceof CommandExitError)) throw error;
          exitCode = error.exitCode;
        }
        options.signal.throwIfAborted();
        return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
      } finally {
        options.signal.removeEventListener("abort", onAbort);
      }
    },
    async pause() {
      await sandbox.pause();
    },
    async kill() {
      try {
        await sandbox.kill();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

export const createE2bSandboxClient: E2bSandboxClientFactory = (
  credentials,
) => {
  const connection = {
    apiKey: credentials.apiKey,
    domain: credentials.domain,
  };
  const identity = createHash("sha256")
    .update(`${credentials.domain}\n${credentials.apiKey}`)
    .digest("hex");
  return {
    accountIdentity: () => identity,
    ensureTemplate: (request) => ensureE2bTemplate(credentials, request),
    async check() {
      await Sandbox.list({ ...connection, limit: 1 }).nextItems();
    },
    close() {},
    async create(request) {
      const sandbox = await Sandbox.create(request.template, {
        ...connection,
        timeoutMs: request.timeoutMs,
        metadata: request.metadata,
        ...(request.pauseOnTimeout
          ? { lifecycle: { onTimeout: "pause" as const } }
          : {}),
      });
      return wrapSandbox(sandbox, request.user);
    },
    async connect(sandboxId, options = {}) {
      return wrapSandbox(
        await Sandbox.connect(sandboxId, {
          ...connection,
          ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
        }),
        options.user ?? null,
      );
    },
    async observe(sandboxId) {
      try {
        return observation(await Sandbox.getInfo(sandboxId, connection));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async pause(sandboxId) {
      try {
        await Sandbox.pause(sandboxId, connection);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        throw new Error(`E2B sandbox ${sandboxId} no longer exists.`);
      }
    },
    async kill(sandboxId) {
      try {
        await Sandbox.kill(sandboxId, connection);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async *list(metadata) {
      const paginator = Sandbox.list({
        ...connection,
        query: { metadata, state: ["running", "paused"] },
      });
      while (paginator.hasNext) {
        for (const info of await paginator.nextItems()) yield observation(info);
      }
    },
  };
};
