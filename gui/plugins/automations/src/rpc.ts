import {
  automationListResponseSchema,
  automationReadResultSchema,
  automationResponseSchema,
  automationRunListResponseSchema,
  automationRunRpcResponseSchema,
  automationRunsInputSchema,
  automationsOverviewResponseSchema,
  type AutomationAgentSummary,
  createAutomationInputSchema,
  linkThreadInputSchema,
  listAutomationsInputSchema,
  projectAutomationInputSchema,
  reviewMarkInputSchema,
  reviewResponseSchema,
  runAutomationInputSchema,
  updateAutomationInputSchema,
} from "./rpc-types.js";
import { z } from "zod";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { AutomationService } from "./service.js";

const cloudAutomationInputSchema = z
  .object({
    action: z.enum(["list", "create", "update", "run", "delete", "hook"]),
  })
  .passthrough();

export const automationRpcContract = defineRpcContract({
  automations_overview: {
    input: z.null(),
    output: automationsOverviewResponseSchema,
  },
  automations_list: {
    input: listAutomationsInputSchema,
    output: automationListResponseSchema,
  },
  automations_get: {
    input: projectAutomationInputSchema,
    output: automationReadResultSchema,
  },
  automations_create: {
    input: createAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_update: {
    input: updateAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_delete: {
    input: projectAutomationInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  automations_pause: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_resume: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_run: {
    input: runAutomationInputSchema,
    output: automationRunRpcResponseSchema,
  },
  // A webhook loop's new secret URL (ADR 0262), shown once.
  automations_new_webhook_url: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_runs: {
    input: automationRunsInputSchema,
    output: automationRunListResponseSchema,
  },
  automations_review: {
    input: z.null(),
    output: reviewResponseSchema,
  },
  automations_review_mark: {
    input: reviewMarkInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  automations_link_thread: {
    input: linkThreadInputSchema,
    output: z.object({ linked: z.boolean() }).strict(),
  },
  // Cloud automations (ADR 0212) live on the website; the app passes requests through.
  cloud_automations: {
    input: cloudAutomationInputSchema,
    output: z.unknown(),
  },
});

type Sdk = Pick<BbPluginApi["sdk"], "cloudroom" | "threads">;
type Cloud = Sdk["cloudroom"];

async function cloudThreadAgent(
  threads: Sdk["threads"],
  threadId: string,
): Promise<AutomationAgentSummary | null> {
  try {
    const [thread, options] = await Promise.all([
      threads.get({ threadId }),
      threads.defaultExecutionOptions({ threadId }),
    ]);
    return {
      providerId: "providerId" in thread ? thread.providerId : null,
      model: options?.model ?? null,
      reasoningLevel: options?.reasoningLevel ?? null,
    };
  } catch {
    return null;
  }
}

async function withCloudAgents(threads: Sdk["threads"], result: unknown) {
  const { automations = [] } = result as {
    automations?: { thread_id: string }[];
  };
  return {
    ...(result as object),
    automations: await Promise.all(
      automations.map(async (automation) => ({
        ...automation,
        agent: await cloudThreadAgent(threads, automation.thread_id),
      })),
    ),
  };
}

export function createRpcHandlers(service: AutomationService, sdk?: Sdk) {
  return {
    async cloud_automations(
      input: z.output<typeof cloudAutomationInputSchema>,
    ) {
      if (!sdk) throw new Error("Cloud automations are unavailable.");
      const result = await sdk.cloudroom.automations(
        input as Parameters<Cloud["automations"]>[0],
      );
      return input.action === "list"
        ? withCloudAgents(sdk.threads, result)
        : result;
    },
    automations_overview() {
      return service.overview();
    },
    automations_list(input: z.output<typeof listAutomationsInputSchema>) {
      return service.list(input);
    },
    automations_get(input: z.output<typeof projectAutomationInputSchema>) {
      return service.get(input);
    },
    automations_create(input: z.output<typeof createAutomationInputSchema>) {
      return service.create(input);
    },
    automations_update(input: z.output<typeof updateAutomationInputSchema>) {
      return service.update(input);
    },
    automations_delete(input: z.output<typeof projectAutomationInputSchema>) {
      return service.delete(input);
    },
    automations_pause(input: z.output<typeof projectAutomationInputSchema>) {
      return service.pause(input);
    },
    automations_resume(input: z.output<typeof projectAutomationInputSchema>) {
      return service.resume(input);
    },
    automations_run(input: z.output<typeof runAutomationInputSchema>) {
      return service.run(input);
    },
    automations_new_webhook_url(
      input: z.output<typeof projectAutomationInputSchema>,
    ) {
      return service.newWebhookUrl(input);
    },
    automations_runs(input: z.output<typeof automationRunsInputSchema>) {
      return service.runs(input);
    },
    automations_review() {
      return service.review();
    },
    automations_review_mark(input: z.output<typeof reviewMarkInputSchema>) {
      return service.markReviewed(input);
    },
    automations_link_thread(input: z.output<typeof linkThreadInputSchema>) {
      return service.linkThread(input);
    },
  };
}
