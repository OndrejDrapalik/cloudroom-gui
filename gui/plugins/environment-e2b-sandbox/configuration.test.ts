import { describe, expect, it } from "vitest";
import { resolveSettings } from "./configuration.js";

const base = {
  apiKey: "e2b_test",
  region: "US (us-west-1)",
  timeoutMinutes: 60,
  idleMinutes: 15,
};

describe("resolveSettings", () => {
  it("resolves trimmed credentials and converts minutes to milliseconds", () => {
    expect(resolveSettings({ ...base, apiKey: " e2b_test " })).toEqual({
      ok: true,
      settings: {
        apiKey: "e2b_test",
        domain: "e2b.app",
        timeoutMs: 3_600_000,
        idleMs: 900_000,
      },
    });
  });

  it("maps every public region to its control-plane domain", () => {
    const domains = [
      "US (us-west-1)",
      "US AWS (us-west-2)",
      "EU (eu-west-1)",
      "Asia Pacific (ap-southeast-1)",
    ].map((region) => {
      const resolved = resolveSettings({ ...base, region });
      return resolved.ok ? resolved.settings.domain : resolved.message;
    });
    expect(domains).toEqual([
      "e2b.app",
      "foxtrot-2.e2b.dev",
      "e2b-juliett.dev",
      "e2b-tango.dev",
    ]);
  });

  it("rejects an unknown region", () => {
    expect(resolveSettings({ ...base, region: "Mars" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("Unknown E2B region"),
    });
  });

  it("requires an API key", () => {
    expect(resolveSettings({ ...base, apiKey: undefined })).toEqual({
      ok: false,
      message: "Set apiKey in the plugin's settings.",
    });
  });

  it("disables idle pausing at zero and bounds the lifetime", () => {
    expect(resolveSettings({ ...base, idleMinutes: 0 })).toMatchObject({
      settings: { idleMs: null },
    });
    expect(resolveSettings({ ...base, timeoutMinutes: 0 })).toMatchObject({
      ok: false,
    });
    expect(resolveSettings({ ...base, timeoutMinutes: 1441 })).toMatchObject({
      ok: false,
    });
  });
});
