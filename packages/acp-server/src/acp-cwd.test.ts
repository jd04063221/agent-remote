import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAcpCwd } from "./index.js";

describe("ACP Server cwd normalization", () => {
  it("converts file:// URIs to filesystem paths cleanly", () => {
    expect(normalizeAcpCwd("file:///tmp/my-project")).toBe(path.resolve("/tmp/my-project"));
  });

  it("resolves normal paths and falls back when empty", () => {
    expect(normalizeAcpCwd("", "/tmp/fallback")).toBe("/tmp/fallback");
    expect(normalizeAcpCwd("/tmp/demo")).toBe(path.resolve("/tmp/demo"));
  });
});
