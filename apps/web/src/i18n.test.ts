import { describe, expect, it } from "vitest";
import { LOCALE_OPTIONS, MESSAGES, resolveLocale, translate, type MessageKey } from "./i18n";

describe("Web UI i18n", () => {
  it("resolves browser locale strings cleanly", () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("zh-SG")).toBe("zh-CN");
    expect(resolveLocale("zh-TW")).toBe("zh-TW");
    expect(resolveLocale("zh-HK")).toBe("zh-TW");
    expect(resolveLocale("ja-JP")).toBe("ja");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("fr-FR")).toBe("en");
  });

  it("interpolates template variables across locales", () => {
    expect(translate("zh-CN", "sidebar.threads", { count: 3 })).toBe("对话线程 (3)");
    expect(translate("en", "sidebar.threads", { count: 3 })).toBe("THREADS (3)");
    expect(translate("ja", "sidebar.threads", { count: 3 })).toBe("スレッド (3)");
  });

  it("has complete non-empty translations for all locales and keys", () => {
    const keys = Object.keys(MESSAGES.en) as MessageKey[];
    expect(keys.length).toBeGreaterThan(80);
    for (const opt of LOCALE_OPTIONS) {
      const dict = MESSAGES[opt.code];
      for (const k of keys) {
        expect(dict[k], `missing ${opt.code}:${k}`).toBeTruthy();
      }
    }
  });
});
