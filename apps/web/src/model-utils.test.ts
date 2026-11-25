import { describe, expect, it } from "vitest";
import {
  buildProfileModelOptions,
  coerceEffortForModel,
  filterModelOptions,
  resolveEffortCapabilities,
} from "./model-utils";
import type { CatalogSnapshot } from "./types";

const AGY_CATALOG: CatalogSnapshot = {
  hostId: "remote-vps",
  profileId: "remote-agy",
  agent: "antigravity",
  currentModelId: "gemini-4-neon-high",
  fetchedAt: "2026-11-25T00:00:00Z",
  models: [
    {
      id: "gemini-4-neon",
      displayName: "Gemini 4 Neon",
      source: "cli-probe",
      isDefault: true,
      effortVariantMap: {
        low: "gemini-4-neon-low",
        medium: "gemini-4-neon-medium",
        high: "gemini-4-neon-high",
        xhigh: "gemini-4-neon-xhigh",
      },
      capabilities: {
        supportsThinking: true,
        supportedEfforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "high",
      },
    },
    {
      id: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      source: "cli-probe",
      capabilities: {
        supportsThinking: true,
        supportedEfforts: ["low", "medium", "high"],
        defaultEffort: "high",
      },
    },
    {
      id: "gemini-pro-orchestrator-neon",
      displayName: "Orchestrator (Neon)",
      source: "cli-probe",
      capabilities: {
        supportsThinking: false,
        supportedEfforts: [],
      },
    },
  ],
};

const OPENCODE_CATALOG: CatalogSnapshot = {
  hostId: "local-box",
  profileId: "local-opencode",
  agent: "opencode",
  fetchedAt: "2026-11-25T00:00:00Z",
  models: Array.from({ length: 230 }, (_, i) =>
    i === 42
      ? {
          id: "opencode-go/deepseek-v4.1-flash",
          displayName: "opencode-go/deepseek-v4.1-flash",
          source: "live-rpc",
          capabilities: { supportsThinking: false, supportedEfforts: [] },
        }
      : {
          id: `provider-${i % 10}/model-${i}`,
          displayName: `Model ${i}`,
          source: "live-rpc",
          capabilities: { supportsThinking: false, supportedEfforts: [] },
        },
  ),
};

describe("model-utils dynamic effort capabilities and search", () => {
  it("returns exact supported efforts for Gemini 4 Neon without max", () => {
    const caps = resolveEffortCapabilities(AGY_CATALOG, "gemini-4-neon");
    expect(caps.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(caps.efforts).not.toContain("max");
    expect(coerceEffortForModel("max", AGY_CATALOG, "gemini-4-neon")).toBe("high");
  });

  it("returns exact supported efforts for Claude Opus without xhigh or max", () => {
    const caps = resolveEffortCapabilities(AGY_CATALOG, "claude-opus-5-5");
    expect(caps.efforts).toEqual(["low", "medium", "high"]);
    expect(coerceEffortForModel("xhigh", AGY_CATALOG, "claude-opus-5-5")).toBe("high");
  });

  it("never fabricates fixed 5 levels when a model or OpenCode catalog has no effort levels", () => {
    expect(
      resolveEffortCapabilities(AGY_CATALOG, "gemini-pro-orchestrator-neon").efforts,
    ).toEqual([]);
    expect(
      resolveEffortCapabilities(OPENCODE_CATALOG, "opencode-go/deepseek-v4.1-flash").efforts,
    ).toEqual([]);
    expect(
      coerceEffortForModel("high", OPENCODE_CATALOG, "opencode-go/deepseek-v4.1-flash"),
    ).toBe("");
    expect(resolveEffortCapabilities(undefined, "").efforts).toEqual([]);
  });

  it("filters 230+ OpenCode models with multi-token search", () => {
    const opts = buildProfileModelOptions(OPENCODE_CATALOG);
    expect(opts).toHaveLength(230);
    const hits = filterModelOptions(opts, "deepseek flash");
    expect(hits.map((h) => h.id)).toEqual(["opencode-go/deepseek-v4.1-flash"]);
  });
});
