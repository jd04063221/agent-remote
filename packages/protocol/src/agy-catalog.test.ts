import { describe, expect, it } from "vitest";
import {
  parseAgyModelsOutput,
  parseAgySessionNewCatalog,
  type AgySessionNewResult,
} from "./agy-catalog.js";

describe("parseAgyModelsOutput (live agy 1.5.16 fixture)", () => {
  const LIVE_OUTPUT = [
    "\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-neon-high             Gemini 4 Neon (High)",
    "gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)",
    "gemini-4-neon-medium           Gemini 4 Neon (Medium)",
    "gemini-4-neon-low              Gemini 4 Neon (Low)",
    "gemini-pro-orchestrator-neon   Orchestrator (Neon)",
    "claude-opus-5-5-low            Claude Opus 5.5 (Low)",
    "claude-opus-5-5-medium         Claude Opus 5.5 (Medium)",
    "claude-opus-5-5-high           Claude Opus 5.5 (High)",
    "gpt-oss-120b-medium            GPT-OSS 120B (Medium)",
  ].join("\n");

  it("groups multi-effort models and preserves exact variant map", () => {
    const models = parseAgyModelsOutput(LIVE_OUTPUT);

    const neon = models.find((m) => m.id === "gemini-4-neon");
    expect(neon).toBeDefined();
    expect(neon?.displayName).toBe("Gemini 4 Neon");
    expect(neon?.capabilities.supportedEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(neon?.effortVariantMap?.xhigh).toBe("gemini-4-neon-xhigh");

    const opus = models.find((m) => m.id === "claude-opus-5-5");
    expect(opus?.capabilities.supportedEfforts).toEqual(["low", "medium", "high"]);

    const orch = models.find((m) => m.id === "gemini-pro-orchestrator-neon");
    expect(orch?.capabilities.supportsThinking).toBe(false);

    const gptOss = models.find((m) => m.id === "gpt-oss-120b-medium");
    expect(gptOss?.capabilities.supportedEfforts).toEqual(["medium"]);
  });

  it("parses non-TTY tab-delimited output from piped agy models", () => {
    const piped = [
      "Fetching available models...",
      "gemini-4-neon-high\tGemini 4 Neon (High)",
      "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
      "claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)",
    ].join("\n");
    const models = parseAgyModelsOutput(piped);
    expect(models).toHaveLength(2);
    expect(models.find((m) => m.id === "gemini-4-neon")?.capabilities.supportedEfforts).toEqual([
      "high",
      "xhigh",
    ]);
  });
});

describe("parseAgySessionNewCatalog (live agy acp fixture)", () => {
  const LIVE_SESSION_NEW: AgySessionNewResult = {
    sessionId: "889a7e92-a321-4c02-afb2-a3c5f562ea8f",
    models: {
      currentModelId: "gemini-4-neon-high",
      availableModels: [
        { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
        { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
        { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
        { modelId: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
        { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
        { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      ],
    },
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gemini-4-neon",
        options: [
          { value: "gemini-4-neon", name: "Gemini 4 Neon" },
          { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
          { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
        ],
      },
      {
        id: "thought_level",
        name: "Thinking Level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
          { value: "xhigh", name: "Extra" },
        ],
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "default", name: "Default" }],
      },
    ],
    _meta: {
      antigravity: {
        tier: { id: "g1-pro-tier", name: "Google AI Pro" },
      },
    },
  };

  it("extracts per-model supported efforts, default model, tier, and extra config options", () => {
    const parsed = parseAgySessionNewCatalog(LIVE_SESSION_NEW);
    expect(parsed.tierName).toBe("Google AI Pro");
    expect(parsed.currentModelId).toBe("gemini-4-neon-high");
    expect(parsed.models).toHaveLength(3);

    const neon = parsed.models.find((m) => m.id === "gemini-4-neon");
    expect(neon?.isDefault).toBe(true);
    expect(neon?.capabilities.supportedEfforts).toEqual(["low", "high", "xhigh"]);
    expect(neon?.effortVariantMap?.xhigh).toBe("gemini-4-neon-xhigh");

    const opus = parsed.models.find((m) => m.id === "claude-opus-5-5");
    expect(opus?.capabilities.supportedEfforts).toEqual(["low", "high"]);

    expect(parsed.extraConfigOptions.map((o) => o.id)).toEqual([
      "thought_level",
      "mode",
    ]);
  });

  it("preserves provider/model IDs (e.g. OpenCode opencode-go/deepseek-v4.1-flash) without inventing efforts", () => {
    const openCodeResult: AgySessionNewResult = {
      sessionId: "oc-sess-1",
      models: {
        currentModelId: "opencode-go/deepseek-v4.1-flash",
        availableModels: [
          {
            modelId: "opencode-go/deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash",
          },
          {
            modelId: "openrouter/anthropic/claude-sonnet-4",
            name: "Claude Sonnet 4",
          },
        ],
      },
    };
    const parsed = parseAgySessionNewCatalog(openCodeResult);
    expect(parsed.models).toHaveLength(2);
    const ds = parsed.models.find((m) => m.id === "opencode-go/deepseek-v4.1-flash");
    expect(ds?.displayName).toBe("DeepSeek V4.1 Flash");
    expect(ds?.isDefault).toBe(true);
    expect(ds?.capabilities.supportedEfforts).toEqual([]);
  });
});
