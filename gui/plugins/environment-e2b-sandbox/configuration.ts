/** Public E2B regions and their control-plane domains (docs.e2b.dev/client, Multiple regions). */
export const REGION_DOMAINS = {
  "US (us-west-1)": "e2b.app",
  "US AWS (us-west-2)": "foxtrot-2.e2b.dev",
  "EU (eu-west-1)": "e2b-juliett.dev",
  "Asia Pacific (ap-southeast-1)": "e2b-tango.dev",
} as const;
export const DEFAULT_REGION = "US (us-west-1)";
const REGION_OPTIONS = Object.keys(REGION_DOMAINS);

export const SETTING_DESCRIPTORS = {
  apiKey: {
    type: "string",
    secret: true,
    label: "E2B API key",
    description:
      "A team API key from the E2B dashboard (Settings → API keys). Starts with e2b_.",
  },
  region: {
    type: "select",
    label: "Region",
    description:
      "The E2B region that issued the API key. Each region is a separate deployment with its own projects and keys.",
    options: REGION_OPTIONS,
    default: DEFAULT_REGION,
  },
  timeoutMinutes: {
    type: "number",
    label: "Sandbox lifetime (minutes)",
    description:
      "E2B pauses the sandbox automatically after this long without a manual pause. Hobby plans allow up to 60, Pro plans up to 1440.",
    default: 60,
  },
  idleMinutes: {
    type: "number",
    label: "Pause after idle (minutes)",
    description:
      "Pause an idle sandbox after this long. Use 0 to keep it running until the sandbox lifetime ends.",
    default: 15,
  },
} as const;

export interface ResolvedSettings {
  apiKey: string;
  domain: string;
  timeoutMs: number;
  idleMs: number | null;
}

export type SettingsResolution =
  | { ok: true; settings: ResolvedSettings }
  | { ok: false; message: string };

export interface RawSettings {
  apiKey: string | undefined;
  region: string;
  timeoutMinutes: number;
  idleMinutes: number;
}

export const MAX_TIMEOUT_MINUTES = 24 * 60;
const MAX_IDLE_MINUTES = 24 * 60;

/** The API domain for a region choice; `null` for a region this plugin does not know. */
export function resolveDomain(region: string): string | null {
  return (REGION_DOMAINS as Record<string, string>)[region] ?? null;
}

export function resolveSettings(raw: RawSettings): SettingsResolution {
  const apiKey = (raw.apiKey ?? "").trim();
  if (apiKey.length === 0) {
    return { ok: false, message: "Set apiKey in the plugin's settings." };
  }
  const domain = resolveDomain(raw.region);
  if (domain === null) {
    return {
      ok: false,
      message: `Unknown E2B region "${raw.region}". Choose one of: ${REGION_OPTIONS.join(", ")}.`,
    };
  }
  if (
    !Number.isInteger(raw.timeoutMinutes) ||
    raw.timeoutMinutes < 1 ||
    raw.timeoutMinutes > MAX_TIMEOUT_MINUTES
  ) {
    return {
      ok: false,
      message: `timeoutMinutes must be a whole number between 1 and ${MAX_TIMEOUT_MINUTES}, not ${raw.timeoutMinutes}.`,
    };
  }
  if (
    !Number.isInteger(raw.idleMinutes) ||
    raw.idleMinutes < 0 ||
    raw.idleMinutes > MAX_IDLE_MINUTES
  ) {
    return {
      ok: false,
      message: `idleMinutes must be a whole number between 0 and ${MAX_IDLE_MINUTES}, not ${raw.idleMinutes}.`,
    };
  }
  return {
    ok: true,
    settings: {
      apiKey,
      domain,
      timeoutMs: raw.timeoutMinutes * 60_000,
      idleMs: raw.idleMinutes === 0 ? null : raw.idleMinutes * 60_000,
    },
  };
}
