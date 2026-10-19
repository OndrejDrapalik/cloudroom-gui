import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { E2bSandboxBackend } from "./providers/e2b/backend.js";
import { MANAGED_METADATA } from "./providers/e2b/backend.js";
import { errorMessage } from "./error-message.js";

export async function sweepE2bSandboxes(
  bb: BbPluginApi,
  backend: E2bSandboxBackend,
): Promise<void> {
  const { client } = await backend.debugContext();
  const hosts = await bb.sdk.hosts.list();
  const ownedKeys = new Set<string>();
  for (const host of hosts) {
    if (host.machineProviderId !== backend.definition.id) continue;
    try {
      const stored = await bb.experimental_machines.getResource(host.id);
      if (stored === null) continue;
      const resource = backend.parseResource(stored);
      ownedKeys.add(resource.key);
      const observed = await backend.observe(resource);
      if (observed === null) continue;
      if (host.lifecycle.phase === "active" && observed.state === "paused") {
        bb.log.info(
          `E2B paused ${observed.sandboxId} on its own; suspending machine ${host.id}`,
        );
        await bb.sdk.hosts.experimental_suspend({ hostId: host.id });
      } else if (
        host.lifecycle.phase === "suspended" &&
        observed.state === "running"
      ) {
        await bb.sdk.hosts.experimental_reconcile({ hostId: host.id });
      }
    } catch (error) {
      if (hasErrorCode(error, "machine_busy")) continue;
      bb.log.warn(`E2B sweep failed for ${host.id}: ${errorMessage(error)}`);
    }
  }
  try {
    for await (const sandbox of client.list(MANAGED_METADATA)) {
      const key = sandbox.metadata.bbMachineKey;
      if (sandbox.metadata.bbDebug === "true" || key === undefined) continue;
      if (!ownedKeys.has(key)) {
        bb.log.warn(
          `Tracked E2B sandbox ${sandbox.sandboxId} has no matching machine; retaining it for inspection`,
        );
      }
    }
  } catch (error) {
    bb.log.warn(`E2B sandbox enumeration failed: ${errorMessage(error)}`);
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}
