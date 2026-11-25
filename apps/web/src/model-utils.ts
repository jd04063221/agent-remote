import type {
  CatalogSnapshot,
  ModelCatalogEntry,
  ProfileState,
  ThinkingEffort,
} from "./types";

const VALID_EFFORTS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface EffortCapabilities {
  /** Exact thinking effort levels supported by this model; empty means Auto / Model Default only. */
  efforts: ThinkingEffort[];
  /** Suggested default effort when `efforts` is non-empty. */
  defaultEffort?: ThinkingEffort;
  /** Matched catalog entry, if found. */
  matchedModel?: ModelCatalogEntry;
}

export interface ModelPickerOption {
  id: string;
  displayName: string;
  supportedEfforts: ThinkingEffort[];
  profileId?: string;
  groupLabel?: string;
}

export function findCatalogForProfile(
  catalogs: CatalogSnapshot[],
  profile?: ProfileState,
): CatalogSnapshot | undefined {
  if (!profile) return undefined;
  return catalogs.find((c) => c.hostId === profile.hostId && c.profileId === profile.id);
}

export function findModelInCatalog(
  catalog: CatalogSnapshot | undefined,
  modelId?: string,
): ModelCatalogEntry | undefined {
  if (!catalog || catalog.models.length === 0) return undefined;
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return (
      catalog.models.find((m) => m.isDefault) ??
      (catalog.currentModelId
        ? catalog.models.find(
            (m) =>
              m.id === catalog.currentModelId ||
              Boolean(
                m.effortVariantMap &&
                  Object.values(m.effortVariantMap).includes(catalog.currentModelId!),
              ),
          )
        : undefined)
    );
  }
  return catalog.models.find(
    (m) =>
      m.id === trimmed ||
      Boolean(m.effortVariantMap && Object.values(m.effortVariantMap).includes(trimmed)),
  );
}

function extractGlobalThoughtLevels(
  catalog: CatalogSnapshot | undefined,
): { efforts: ThinkingEffort[]; defaultEffort?: ThinkingEffort } {
  const thoughtOpt = catalog?.extraConfigOptions?.find(
    (o) => o.category === "thought_level" || o.id === "thought_level",
  );
  const efforts = (thoughtOpt?.options ?? [])
    .map((o) => o.value)
    .filter((v): v is ThinkingEffort => VALID_EFFORTS.has(v));
  if (efforts.length === 0) return { efforts: [] };
  const def =
    thoughtOpt?.defaultValue && efforts.includes(thoughtOpt.defaultValue as ThinkingEffort)
      ? (thoughtOpt.defaultValue as ThinkingEffort)
      : efforts[0];
  return { efforts, defaultEffort: def };
}

/**
 * Resolves the exact thinking effort options advertised by the connected agent for the chosen model.
 * Never fabricates a hardcoded 5-level fallback (e.g. never invents `max` for models like Gemini 4 Neon
 * or OpenCode models that do not advertise configurable thinking levels).
 */
export function resolveEffortCapabilities(
  catalog: CatalogSnapshot | undefined,
  modelId?: string,
): EffortCapabilities {
  const matchedModel = findModelInCatalog(catalog, modelId);
  if (matchedModel) {
    const efforts = matchedModel.capabilities.supportedEfforts ?? [];
    if (efforts.length > 0) {
      return {
        efforts,
        defaultEffort: matchedModel.capabilities.defaultEffort ?? efforts[0],
        matchedModel,
      };
    }
    // Only apply catalog-level thought_level options if the catalog does NOT carry per-model efforts
    const hasPerModelEfforts = (catalog?.models ?? []).some(
      (m) => (m.capabilities.supportedEfforts?.length ?? 0) > 0,
    );
    if (!hasPerModelEfforts) {
      const global = extractGlobalThoughtLevels(catalog);
      if (global.efforts.length > 0) {
        return { ...global, matchedModel };
      }
    }
    return { efforts: [], defaultEffort: undefined, matchedModel };
  }

  // When no specific model is selected yet (auto/default), expose catalog-level thought levels if advertised
  if (!modelId?.trim()) {
    const global = extractGlobalThoughtLevels(catalog);
    if (global.efforts.length > 0) {
      return global;
    }
  }
  return { efforts: [], defaultEffort: undefined };
}

export function coerceEffortForModel(
  current: ThinkingEffort | "" | undefined,
  catalog: CatalogSnapshot | undefined,
  modelId?: string,
  allowEmpty = false,
): ThinkingEffort | "" {
  const { efforts, defaultEffort } = resolveEffortCapabilities(catalog, modelId);
  if (efforts.length === 0) return "";
  if (current && efforts.includes(current)) return current;
  if (allowEmpty && !current) return "";
  return defaultEffort ?? efforts[0] ?? "";
}

export function filterModelOptions(
  options: ModelPickerOption[],
  query: string,
): ModelPickerOption[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return options;
  return options.filter((opt) => {
    const hay = `${opt.id} ${opt.displayName} ${opt.groupLabel ?? ""}`.toLowerCase();
    return tokens.every((tok) => hay.includes(tok));
  });
}

export function buildProfileModelOptions(
  catalog: CatalogSnapshot | undefined,
  profile?: ProfileState,
): ModelPickerOption[] {
  if (!catalog) return [];
  const groupLabel = profile ? `${profile.name} (${profile.agent}@${profile.hostId})` : undefined;
  return catalog.models.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    supportedEfforts: m.capabilities.supportedEfforts ?? [],
    profileId: profile?.id,
    groupLabel,
  }));
}
