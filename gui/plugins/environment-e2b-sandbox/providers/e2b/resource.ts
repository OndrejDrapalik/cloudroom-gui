import { z } from "zod";

export const e2bMachineResourceSchema = z.object({
  key: z.string().min(1),
  sandboxId: z.string().min(1),
  state: z.enum(["running", "paused"]),
  template: z.string().min(1),
  user: z.string().min(1).nullable(),
  accountIdentity: z.string().min(1),
  domain: z.string().min(1),
});
export type E2bMachineResource = z.infer<typeof e2bMachineResourceSchema>;
export function readE2bMachineResource(value: unknown): E2bMachineResource {
  return e2bMachineResourceSchema.parse(value);
}
