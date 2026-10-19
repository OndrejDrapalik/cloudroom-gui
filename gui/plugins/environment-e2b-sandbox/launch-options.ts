import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ImageDefinition } from "./image-definition.js";
import { dockerfileSchema } from "./image-definition.js";
import { readStandardImage } from "./standard-image.js";

const nameSchema = z.string().trim().min(1).max(80);

export const sandboxPresetSchema = z
  .object({
    name: nameSchema,
    cpuCount: z.number().int().min(1).max(64),
    memoryMiB: z.number().int().multipleOf(512).min(512),
  })
  .strict();

export const e2bImageSchema = z.discriminatedUnion("source", [
  z
    .object({
      name: nameSchema,
      source: z.literal("dockerfile"),
      dockerfile: dockerfileSchema,
    })
    .strict(),
  z
    .object({
      name: nameSchema,
      source: z.literal("template"),
      template: z.string().trim().min(1).max(200),
    })
    .strict(),
]);

export const e2bLaunchOptionsSchema = z
  .object({
    presets: z.array(sandboxPresetSchema).max(20),
    images: z.array(e2bImageSchema).min(1).max(20),
  })
  .strict();

export type SandboxPreset = z.infer<typeof sandboxPresetSchema>;
export type E2bImage = z.infer<typeof e2bImageSchema>;
export type E2bLaunchOptions = z.infer<typeof e2bLaunchOptionsSchema>;

const PRESETS_KEY = "sandbox-size-presets";
const EXTRA_IMAGES_KEY = "named-images";

function requireUniqueNames(
  kind: string,
  entries: readonly { name: string }[],
): void {
  const names = new Set<string>();
  for (const entry of entries) {
    const normalized = entry.name.toLocaleLowerCase();
    if (names.has(normalized)) {
      throw new Error(`${kind} names must be unique.`);
    }
    names.add(normalized);
  }
}

export function e2bLaunchOptions(
  bb: Pick<BbPluginApi, "storage">,
  image: ImageDefinition,
) {
  async function get(): Promise<E2bLaunchOptions> {
    const [storedPresets, storedImages, standard] = await Promise.all([
      bb.storage.kv.get<unknown>(PRESETS_KEY),
      bb.storage.kv.get<unknown>(EXTRA_IMAGES_KEY),
      image.get(),
    ]);
    const presets =
      storedPresets === undefined
        ? []
        : z.array(sandboxPresetSchema).max(20).parse(storedPresets);
    const extraImages =
      storedImages === undefined
        ? []
        : z.array(e2bImageSchema).max(19).parse(storedImages);
    const options = {
      presets,
      images: [
        {
          name: "Default",
          source: "dockerfile" as const,
          dockerfile: standard.dockerfile,
        },
        ...extraImages,
      ],
    };
    requireUniqueNames("Preset", options.presets);
    requireUniqueNames("Image", options.images);
    return options;
  }

  async function set(value: E2bLaunchOptions): Promise<E2bLaunchOptions> {
    const parsed = e2bLaunchOptionsSchema.parse(value);
    const [standard, ...extraImages] = parsed.images;
    if (standard?.name !== "Default" || standard.source !== "dockerfile") {
      throw new Error(
        'The first image must be the bundled "Default" Dockerfile.',
      );
    }
    requireUniqueNames("Preset", parsed.presets);
    requireUniqueNames("Image", parsed.images);
    await Promise.all(
      parsed.images.map((entry) =>
        entry.source === "dockerfile"
          ? readStandardImage(entry.dockerfile)
          : Promise.resolve(),
      ),
    );
    await image.set(standard.dockerfile);
    await Promise.all([
      bb.storage.kv.set(PRESETS_KEY, parsed.presets),
      bb.storage.kv.set(EXTRA_IMAGES_KEY, extraImages),
    ]);
    return get();
  }

  return { get, set };
}

export type E2bLaunchOptionsStore = ReturnType<typeof e2bLaunchOptions>;
