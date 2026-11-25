import {
  THINKING_EFFORTS,
  type ModelCatalogEntry,
  type ModelParam,
  type ThinkingEffort,
} from "./types.js";

const EFFORT_SUFFIX_RE = /-(off|minimal|low|medium|high|xhigh|max)$/;
const DISPLAY_EFFORT_RE = /\s*\((Off|Minimal|Low|Medium|High|XHigh|Extra|Max)\)\s*$/i;
const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

function normalizeEffort(raw: string): ThinkingEffort | undefined {
  const lower = raw.trim().toLowerCase();
  if (lower === "extra") return "xhigh";
  if ((THINKING_EFFORTS as readonly string[]).includes(lower)) {
    return lower as ThinkingEffort;
  }
  return undefined;
}

function sortEfforts(efforts: Iterable<ThinkingEffort>): ThinkingEffort[] {
  const set = new Set(efforts);
  return THINKING_EFFORTS.filter((lvl) => set.has(lvl));
}

export interface AgySessionNewResult {
  sessionId?: string;
  models?: {
    currentModelId?: string;
    availableModels?: Array<{ modelId: string; name: string }>;
  };
  configOptions?: Array<{
    id: string;
    name: string;
    category?: string;
    type: string;
    currentValue?: string;
    options?: Array<{ value: string; name: string; description?: string }>;
  }>;
  _meta?: {
    antigravity?: {
      tier?: { id?: string; name?: string };
    };
  };
}

/**
 * Parses raw `agy models` stdout into normalized ModelCatalogEntry items grouped by base model family.
 * Verified against agy v1.5.16 live output.
 */
export function parseAgyModelsOutput(rawOutput: string): ModelCatalogEntry[] {
  const cleaned = rawOutput.replace(ANSI_ESCAPE_RE, "");
  const lines = cleaned.split(/\r?\n/);

  const grouped = new Map<
    string,
    {
      displayName: string;
      efforts: Set<ThinkingEffort>;
      variantMap: Partial<Record<ThinkingEffort, string>>;
      rawSlugs: string[];
    }
  >();

  for (const rawLine of lines) {
    // Strip carriage-return spinner prefixes on the same line
    const segments = rawLine.split("\r");
    const line = (segments[segments.length - 1] ?? "").trim();
    if (!line || line.includes("Fetching available models")) continue;

    const match = /^([a-zA-Z0-9][a-zA-Z0-9._:/-]+)(?:\t+|\s{2,})(.+)$/.exec(line);
    if (!match) continue;

    const slug = match[1]!;
    const label = match[2]!.trim();

    const suffixMatch = EFFORT_SUFFIX_RE.exec(slug);
    const effort = suffixMatch ? normalizeEffort(suffixMatch[1]!) : undefined;
    const baseId = effort ? slug.slice(0, -suffixMatch![0].length) : slug;
    const baseDisplay = effort ? label.replace(DISPLAY_EFFORT_RE, "").trim() : label;

    let entry = grouped.get(baseId);
    if (!entry) {
      entry = {
        displayName: baseDisplay || baseId,
        efforts: new Set<ThinkingEffort>(),
        variantMap: {},
        rawSlugs: [],
      };
      grouped.set(baseId, entry);
    }

    entry.rawSlugs.push(slug);
    if (effort) {
      entry.efforts.add(effort);
      entry.variantMap[effort] = slug;
    }
  }

  const result: ModelCatalogEntry[] = [];
  for (const [baseId, data] of grouped.entries()) {
    const supportedEfforts = sortEfforts(data.efforts);
    const singleUnsuffixed = supportedEfforts.length === 0;
    const onlyOneVariant = data.rawSlugs.length === 1 && supportedEfforts.length === 1;
    // Keep exact slug when model only exists as a single fixed-effort slug (e.g. gpt-oss-120b-medium)
    const id = onlyOneVariant ? data.rawSlugs[0]! : baseId;
    const displayName = onlyOneVariant
      ? `${data.displayName} (${supportedEfforts[0]!.charAt(0).toUpperCase()}${supportedEfforts[0]!.slice(1)})`
      : data.displayName;

    result.push({
      id,
      displayName,
      source: "cli-probe",
      effortVariantMap:
        Object.keys(data.variantMap).length > 0 ? data.variantMap : undefined,
      capabilities: {
        supportsThinking: !singleUnsuffixed,
        supportedEfforts,
        defaultEffort: supportedEfforts.includes("high")
          ? "high"
          : supportedEfforts.includes("medium")
            ? "medium"
            : supportedEfforts[0],
      },
    });
  }

  return result;
}

/**
 * Parses `agy acp` `session/new` JSON-RPC result into a normalized model catalog + extra config options.
 * Combines `configOptions` (base model picker + thought_level) with `models.availableModels` (per-model effort matrix).
 */
export function parseAgySessionNewCatalog(result: AgySessionNewResult): {
  currentModelId?: string;
  tierName?: string;
  models: ModelCatalogEntry[];
  extraConfigOptions: ModelParam[];
} {
  const available = result.models?.availableModels ?? [];
  const configOptions = result.configOptions ?? [];
  const modelOpt = configOptions.find((o) => o.id === "model" || o.category === "model");
  const currentBaseModel = modelOpt?.currentValue;

  // Build exact per-base-model effort availability from models.availableModels
  const variantsByBase = new Map<
    string,
    {
      displayName: string;
      efforts: Set<ThinkingEffort>;
      variantMap: Partial<Record<ThinkingEffort, string>>;
    }
  >();

  for (const item of available) {
    const suffixMatch = EFFORT_SUFFIX_RE.exec(item.modelId);
    const effort = suffixMatch ? normalizeEffort(suffixMatch[1]!) : undefined;
    const baseId = effort ? item.modelId.slice(0, -suffixMatch![0].length) : item.modelId;
    const baseName = effort
      ? item.name.replace(DISPLAY_EFFORT_RE, "").trim()
      : item.name;

    let bucket = variantsByBase.get(baseId);
    if (!bucket) {
      bucket = { displayName: baseName, efforts: new Set(), variantMap: {} };
      variantsByBase.set(baseId, bucket);
    }
    if (effort) {
      bucket.efforts.add(effort);
      bucket.variantMap[effort] = item.modelId;
    }
    // Also index by exact modelId for single-variant entries like gpt-oss-120b-medium
    if (item.modelId !== baseId && !variantsByBase.has(item.modelId)) {
      const exactSet = new Set<ThinkingEffort>();
      const exactMap: Partial<Record<ThinkingEffort, string>> = {};
      if (effort) {
        exactSet.add(effort);
        exactMap[effort] = item.modelId;
      }
      variantsByBase.set(item.modelId, {
        displayName: item.name,
        efforts: exactSet,
        variantMap: exactMap,
      });
    }
  }

  const models: ModelCatalogEntry[] = [];

  if (modelOpt?.options && modelOpt.options.length > 0) {
    for (const opt of modelOpt.options) {
      const bucket = variantsByBase.get(opt.value);
      const supportedEfforts = bucket ? sortEfforts(bucket.efforts) : [];
      models.push({
        id: opt.value,
        displayName: opt.name,
        source: "live-rpc",
        isDefault: opt.value === currentBaseModel,
        effortVariantMap:
          bucket && Object.keys(bucket.variantMap).length > 0
            ? bucket.variantMap
            : undefined,
        capabilities: {
          supportsThinking: supportedEfforts.length > 0,
          supportedEfforts,
          defaultEffort: supportedEfforts.includes("high")
            ? "high"
            : supportedEfforts.includes("medium")
              ? "medium"
              : supportedEfforts[0],
        },
      });
    }
  } else {
    // Fallback if configOptions omitted (e.g. OpenCode ACP listing provider/model entries in availableModels)
    const seenBase = new Set<string>();
    for (const item of available) {
      const suffixMatch = EFFORT_SUFFIX_RE.exec(item.modelId);
      const effort = suffixMatch ? normalizeEffort(suffixMatch[1]!) : undefined;
      const baseId = effort ? item.modelId.slice(0, -suffixMatch![0].length) : item.modelId;
      if (seenBase.has(baseId)) continue;
      seenBase.add(baseId);
      const bucket = variantsByBase.get(baseId);
      const supportedEfforts = bucket ? sortEfforts(bucket.efforts) : [];
      const singleFixed =
        supportedEfforts.length === 1 &&
        available.filter((a) => {
          const sm = EFFORT_SUFFIX_RE.exec(a.modelId);
          const b = sm ? a.modelId.slice(0, -sm[0].length) : a.modelId;
          return b === baseId;
        }).length === 1;
      const id = singleFixed ? item.modelId : baseId;
      const displayName = singleFixed ? item.name : (bucket?.displayName || item.name || id);
      models.push({
        id,
        displayName,
        source: "live-rpc",
        isDefault:
          id === result.models?.currentModelId ||
          item.modelId === result.models?.currentModelId ||
          baseId === currentBaseModel,
        effortVariantMap:
          bucket && Object.keys(bucket.variantMap).length > 0 ? bucket.variantMap : undefined,
        capabilities: {
          supportsThinking: supportedEfforts.length > 0,
          supportedEfforts,
          defaultEffort: supportedEfforts.includes("high")
            ? "high"
            : supportedEfforts.includes("medium")
              ? "medium"
              : supportedEfforts[0],
        },
      });
    }
  }

  const extraConfigOptions: ModelParam[] = configOptions
    .filter((o) => o.id !== "model" && o.category !== "model")
    .map((o) => ({
      id: o.id,
      category:
        o.category === "thought_level" || o.category === "mode"
          ? o.category
          : "custom",
      label: o.name,
      type: "select" as const,
      defaultValue: o.currentValue,
      options: (o.options ?? []).map((opt) => ({
        value: opt.value,
        label: opt.name,
        description: opt.description,
      })),
    }));

  return {
    currentModelId: result.models?.currentModelId ?? currentBaseModel,
    tierName: result._meta?.antigravity?.tier?.name,
    models,
    extraConfigOptions,
  };
}
