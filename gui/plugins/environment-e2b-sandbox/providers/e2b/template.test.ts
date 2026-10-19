import { describe, expect, it } from "vitest";
import { Template } from "e2b";
import { readStandardDockerfile } from "../../standard-image.js";
import { templateAlias, templateFromDockerfile } from "./template.js";

describe("templateAlias", () => {
  it("derives a stable lowercase alias from the Dockerfile and size", () => {
    const plain = templateAlias("FROM debian\n", null);
    expect(plain).toMatch(/^bb-standard-[0-9a-f]{24}$/u);
    expect(templateAlias("FROM debian\n", null)).toBe(plain);
    expect(
      templateAlias("FROM debian\n", { cpuCount: 4, memoryMiB: 8192 }),
    ).toBe(`${plain}-4c8192m`);
    expect(templateAlias("FROM ubuntu\n", null)).not.toBe(plain);
  });
});

describe("templateFromDockerfile", () => {
  it("translates the supported instruction subset into template steps", async () => {
    const dockerfile = [
      "# comment",
      "FROM node:22-bookworm-slim",
      "RUN apt-get update \\",
      "    && apt-get install -y git",
      'ENV FOO=bar BAZ="a b"',
      "WORKDIR /home/node",
      "USER node",
      "",
    ].join("\n");
    const { builder, user } = await templateFromDockerfile(dockerfile);
    const rendered = Template.toDockerfile(builder);
    expect(user).toBe("node");
    expect(rendered).toContain("FROM node:22-bookworm-slim");
    expect(rendered).toMatch(/RUN apt-get update\s+&& apt-get install -y git/u);
    expect(rendered).toMatch(/ENV FOO=bar/u);
    expect(rendered).toMatch(/BAZ=a b|BAZ="a b"/u);
    expect(rendered).toContain("WORKDIR /home/node");
    expect(rendered).toContain("USER node");
  });

  it("accepts the bundled Dockerfile", async () => {
    const dockerfile = await readStandardDockerfile();
    const { builder, user } = await templateFromDockerfile(dockerfile);
    const rendered = Template.toDockerfile(builder);
    expect(user).toBe("node");
    expect(rendered).toContain("npm install -g");
    expect(rendered).toContain("USER node");
  });

  it("runs build steps as root until the Dockerfile switches user", async () => {
    const { builder, user } = await templateFromDockerfile(
      "FROM debian\nRUN id\nUSER app\nRUN id\n",
    );
    expect(user).toBe("app");
    const json = JSON.parse(await Template.toJSON(builder)) as {
      steps: { type: string; args: string[] }[];
    };
    const runs = json.steps.filter((step) => step.type === "RUN");
    expect(runs.map((step) => step.args.at(-1))).toEqual(["root", "app"]);
  });

  it("rejects instructions outside the subset", async () => {
    await expect(
      templateFromDockerfile("FROM debian\nCOPY . /app\n"),
    ).rejects.toThrow(/requires one FROM/u);
  });
});

