import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";
import { createHash } from "node:crypto";
import {
  ApiClient,
  ConnectionConfig,
  Template,
  type TemplateBuilder,
} from "e2b";
import { readStandardImage } from "../../standard-image.js";
import type { E2bCredentials } from "./client.js";

export interface E2bTemplateRequest {
  displayName: string;
  dockerfile: string;
  size: { cpuCount: number; memoryMiB: number } | null;
  signal: AbortSignal;
  report: PluginMachineProviderProgress;
}

export interface E2bTemplateResult {
  template: string;
  user: string | null;
}

export type E2bTemplateStatus = "ready" | "building" | "absent";

export function templateAlias(
  dockerfile: string,
  size: E2bTemplateRequest["size"],
): string {
  const digest = createHash("sha256")
    .update(dockerfile)
    .digest("hex")
    .slice(0, 24);
  const variant = size === null ? "" : `-${size.cpuCount}c${size.memoryMiB}m`;
  return `bb-standard-${digest}${variant}`;
}

export async function templateFromDockerfile(
  dockerfile: string,
): Promise<{ builder: TemplateBuilder; user: string | null }> {
  const definition = await readStandardImage(dockerfile);
  let builder = Template().fromImage(definition.reference);
  let user: string | null = null;
  for (const command of definition.commands) {
    const space = command.indexOf(" ");
    const instruction = command.slice(0, space);
    const argument = command.slice(space + 1).trim();
    switch (instruction) {
      case "RUN":
        builder = builder.runCmd(argument, { user: user ?? "root" });
        break;
      case "ENV": {
        const envs: Record<string, string> = {};
        for (const match of argument.matchAll(
          /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/gu,
        )) {
          const raw = match[2] ?? "";
          envs[match[1]!] =
            raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
        }
        if (Object.keys(envs).length === 0) {
          const [name, ...rest] = argument.split(/\s+/u);
          if (name) envs[name] = rest.join(" ");
        }
        builder = builder.setEnvs(envs);
        break;
      }
      case "WORKDIR":
        builder = builder.setWorkdir(argument);
        break;
      case "USER":
        user = argument;
        builder = builder.setUser(argument);
        break;
      default:
        throw new Error(`Unsupported Dockerfile instruction: ${instruction}`);
    }
  }
  return { builder, user };
}

export async function templateStatus(
  credentials: E2bCredentials,
  alias: string,
  signal?: AbortSignal,
): Promise<E2bTemplateStatus> {
  const config = new ConnectionConfig({
    apiKey: credentials.apiKey,
    domain: credentials.domain,
  });
  const api = new ApiClient(config).api;
  const lookup = await api.GET("/templates/aliases/{alias}", {
    params: { path: { alias } },
    signal,
  });
  if (lookup.response.status === 404) return "absent";
  if (lookup.error !== undefined || lookup.data === undefined) {
    throw new Error(
      `E2B template lookup failed with status ${lookup.response.status}`,
    );
  }
  const templateId = lookup.data.templateID;
  const listing = await api.GET("/templates", { signal });
  if (listing.error !== undefined || listing.data === undefined) {
    throw new Error(
      `E2B template listing failed with status ${listing.response.status}`,
    );
  }
  const template = listing.data.find(
    (candidate) => candidate.templateID === templateId,
  );
  if (template === undefined) return "absent";
  switch (template.buildStatus) {
    case "ready":
      return "ready";
    case "building":
    case "waiting":
      return "building";
    default:
      return "absent";
  }
}

const BUILD_POLL_MS = 5_000;

export async function ensureE2bTemplate(
  credentials: E2bCredentials,
  request: E2bTemplateRequest,
  sleep: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<E2bTemplateResult> {
  request.signal.throwIfAborted();
  const alias = templateAlias(request.dockerfile, request.size);
  const { builder, user } = await templateFromDockerfile(request.dockerfile);
  let status = await templateStatus(credentials, alias, request.signal);
  if (status === "building") {
    request.report.step(
      `Waiting for the ${request.displayName} E2B template build…`,
    );
    while (status === "building") {
      await sleep(BUILD_POLL_MS);
      request.signal.throwIfAborted();
      status = await templateStatus(credentials, alias, request.signal);
    }
  }
  request.signal.throwIfAborted();
  if (status === "ready") {
    request.report.log(`Reusing the ${request.displayName} E2B template\n`);
    return { template: alias, user };
  }
  request.report.step(
    `Building the ${request.displayName} E2B template (first launch)…`,
  );
  await Template.build(builder, {
    apiKey: credentials.apiKey,
    domain: credentials.domain,
    alias,
    ...(request.size === null
      ? {}
      : { cpuCount: request.size.cpuCount, memoryMB: request.size.memoryMiB }),
    onBuildLogs: (entry) => request.report.log(`${entry.message}\n`),
  });
  request.signal.throwIfAborted();
  request.report.log(`${request.displayName} E2B template ready\n`);
  return { template: alias, user };
}
