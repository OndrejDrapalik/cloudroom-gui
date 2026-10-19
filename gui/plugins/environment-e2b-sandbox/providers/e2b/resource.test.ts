import { expect, it } from "vitest";
import { readE2bMachineResource } from "./resource.js";

const resource = {
  key: "machine-key",
  sandboxId: "sbx-1",
  state: "paused",
  template: "bb-standard-abc",
  user: "node",
  accountIdentity: "identity",
  domain: "e2b.app",
};

it("parses a persisted machine resource", () => {
  expect(readE2bMachineResource(resource)).toEqual(resource);
});

it("rejects unknown states and missing sandbox identity", () => {
  expect(() =>
    readE2bMachineResource({ ...resource, state: "suspended" }),
  ).toThrow();
  expect(() => readE2bMachineResource({ ...resource, sandboxId: "" })).toThrow();
});
