import { describe, expect, it } from "vitest";
import { colorizeUnifiedDiff, parseChatSlashCommand } from "./chat.js";

describe("ar chat slash commands & diff rendering", () => {
  it("parses slash commands cleanly", () => {
    expect(parseChatSlashCommand("hello world")).toBeNull();
    expect(parseChatSlashCommand("/model gemini-4-neon")).toEqual({
      kind: "model",
      arg: "gemini-4-neon",
    });
    expect(parseChatSlashCommand("/effort xhigh")).toEqual({
      kind: "effort",
      arg: "xhigh",
    });
    expect(parseChatSlashCommand("/quota")).toEqual({ kind: "quota", arg: undefined });
    expect(parseChatSlashCommand("/usage")).toEqual({ kind: "usage", arg: undefined });
    expect(parseChatSlashCommand("/history")).toEqual({ kind: "history", arg: undefined });
    expect(parseChatSlashCommand("/threads")).toEqual({ kind: "threads", arg: undefined });
    expect(parseChatSlashCommand("/quit")).toEqual({ kind: "exit" });
  });

  it("applies ANSI colors to unified diff hunks", () => {
    const out = colorizeUnifiedDiff("@@ -1,1 +1,1 @@\n-old\n+new");
    expect(out).toContain("\x1b[36m@@ -1,1 +1,1 @@");
    expect(out).toContain("\x1b[31m-old");
    expect(out).toContain("\x1b[32m+new");
  });
});
