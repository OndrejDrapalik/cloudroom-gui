import { useCallback, useEffect, useMemo, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { automationRpcContract } from "./src/rpc.js";
import type { AutomationAgentSummary } from "./src/rpc-types.js";

// Cloud loops (ADR 0212) run on Cloudroom's servers and re-prompt a Cloud thread, even while this Mac is off.
// Agents create them with `room-cli loop create --cloud`; the Overview shows, pauses, runs, and deletes them.
export type CloudAutomation = {
  id: string;
  thread_id: string;
  name: string;
  cron: string | null;
  timezone: string;
  run_at: string | null;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  runs: number;
  agent?: AutomationAgentSummary | null;
};
export type CloudAutomationActions = {
  onOpen: (a: CloudAutomation) => void;
  onRun: (a: CloudAutomation) => void;
  onDelete: (a: CloudAutomation) => void;
  onEnabledChange: (a: CloudAutomation, enabled: boolean) => void;
};
type Request =
  | { action: "list" }
  | { action: "update"; id: string; enabled: boolean }
  | { action: "run" | "delete"; id: string };

export function useCloudAutomations(): {
  rows: CloudAutomation[];
  actions: CloudAutomationActions;
} {
  const rpc = useRpc<typeof automationRpcContract>();
  const navigate = useBbNavigate();
  const [rows, setRows] = useState<CloudAutomation[]>([]);
  const call = useCallback(
    (request: Request) => rpc.call("cloud_automations", request),
    [rpc],
  );
  const load = useCallback(
    () =>
      call({ action: "list" }).then(
        (value) =>
          setRows(
            (value as { automations?: CloudAutomation[] }).automations ?? [],
          ),
        () => setRows([]),
      ),
    [call],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = useCallback(
    async (request: Request, done: string) => {
      try {
        await call(request);
        toast.success(done);
      } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      await load();
    },
    [call, load],
  );
  const actions = useMemo<CloudAutomationActions>(
    () => ({
      onOpen: (a) => navigate.toThread(a.thread_id),
      onRun: (a) =>
        void act({ action: "run", id: a.id }, "Runs within a minute"),
      onDelete: (a) => {
        if (window.confirm(`Delete "${a.name}"?`))
          void act({ action: "delete", id: a.id }, "Deleted");
      },
      onEnabledChange: (a, enabled) =>
        void act(
          { action: "update", id: a.id, enabled },
          enabled ? "Resumed" : "Paused",
        ),
    }),
    [act, navigate],
  );
  return { rows, actions };
}
