import { describe, expect, it } from "vitest";
import { readStandardDockerfile } from "../../standard-image.js";
import { createE2bSandboxClient, createE2bSandboxExecutor } from "./client.js";
import { PROVIDER_ID } from "../../provider-id.js";

const apiKey = process.env.E2B_LIVE_API_KEY;
const domain = process.env.E2B_LIVE_DOMAIN ?? "e2b.app";
const live = apiKey !== undefined && apiKey.length > 0;

describe.skipIf(!live)("E2B live lifecycle (E2B_LIVE_API_KEY)", () => {
  it(
    "builds the bundled template, runs commands with stdin, pauses, resumes and kills",
    async () => {
      const client = createE2bSandboxClient({ apiKey: apiKey!, domain });
      const key = `bb-live-${Date.now()}`;
      const logs: string[] = [];
      const report = {
        step: (text: string) => logs.push(`STEP ${text}`),
        log: (text: string) => logs.push(text),
      };
      await client.check();
      let built: { template: string; user: string | null };
      try {
        built = await client.ensureTemplate({
          displayName: "Default",
          dockerfile: await readStandardDockerfile(),
          size: null,
          signal: new AbortController().signal,
          report,
        });
      } finally {
        process.stderr.write(logs.join(""));
      }
      expect(built.template).toMatch(/^bb-standard-[0-9a-f]{24}$/u);
      expect(built.user).toBe("node");

      const metadata = { bbProvider: PROVIDER_ID, bbMachineKey: key };
      const sandbox = await client.create({
        template: built.template,
        user: built.user,
        timeoutMs: 10 * 60_000,
        metadata,
        pauseOnTimeout: true,
      });
      try {
        const signal = new AbortController().signal;
        const versions = await sandbox.exec(
          ["bash", "-lc", "node --version && git --version && whoami && pwd"],
          { timeoutMs: 30_000, signal },
        );
        console.log(versions);
        expect(versions.exitCode).toBe(0);
        expect(versions.stdout).toMatch(/^v22\./u);
        expect(versions.stdout).toContain("node\n/home/node");

        const executor = createE2bSandboxExecutor(sandbox);
        const chunks: string[] = [];
        const echoed = await executor.exec({
          command: ["sh", "-c", "cat > /tmp/secret && wc -c < /tmp/secret && exit 3"],
          timeoutMs: 30_000,
          signal,
          stdin: "bootstrap-secret\n",
          onOutput: (chunk) => chunks.push(chunk),
        });
        expect(echoed).toEqual({ exitCode: 3 });
        expect(chunks.join("")).toContain("17");

        const listed: string[] = [];
        for await (const entry of client.list(metadata))
          listed.push(entry.sandboxId);
        expect(listed).toEqual([sandbox.sandboxId]);

        await sandbox.pause();
        await expect(client.observe(sandbox.sandboxId)).resolves.toMatchObject({
          state: "paused",
          expiresAt: null,
        });
        const resumed = await client.connect(sandbox.sandboxId, {
          timeoutMs: 10 * 60_000,
          user: built.user,
        });
        await expect(client.observe(sandbox.sandboxId)).resolves.toMatchObject({
          state: "running",
        });
        const survived = await resumed.exec(["cat", "/tmp/secret"], {
          timeoutMs: 30_000,
          signal,
        });
        expect(survived.stdout).toBe("bootstrap-secret\n");
      } finally {
        await sandbox.kill();
      }
      await expect(client.observe(sandbox.sandboxId)).resolves.toBeNull();
    },
    15 * 60_000,
  );
});
