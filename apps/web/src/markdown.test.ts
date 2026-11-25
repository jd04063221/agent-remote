import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isSafeUrl, parseInline, parseMarkdownBlocks } from "./markdown";
import { MarkdownContent } from "./MarkdownContent";

function renderMd(content: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownContent, { content }));
}

describe("Markdown parser and React renderer", () => {
  it("renders Chinese bold, italic, strikethrough, and CJK punctuation adjacency cleanly", () => {
    const html = renderMd(
      "类似**应该加重**这类，以及**“重要提示”**：（**加粗**）和***斜体加粗***与~~已废弃~~。",
    );
    expect(html).toContain("<strong>应该加重</strong>");
    expect(html).toContain("<strong>“重要提示”</strong>：");
    expect(html).toContain("（<strong>加粗</strong>）");
    expect(html).toContain("<strong><em>斜体加粗</em></strong>");
    expect(html).toContain("<del>已废弃</del>");
  });

  it("handles nested bold + italic and inline code containing asterisks without breaking", () => {
    const html = renderMd("支持 **外层加粗含 *内层斜体*** 以及 **`a**b`** 与 `x * y`。");
    expect(html).toContain("<strong>外层加粗含 <em>内层斜体</em></strong>");
    expect(html).toContain('<strong><code class="md-inline-code">a**b</code></strong>');
    expect(html).toContain('<code class="md-inline-code">x * y</code>');
  });

  it("does not corrupt snake_case identifiers or multiplication expressions", () => {
    const html = renderMd("函数 `foo` 和变量 my_var_name 以及 foo__bar__baz 还有 2 * 3 * 4 = 24");
    expect(html).toContain("my_var_name");
    expect(html).not.toContain("<em>var</em>");
    expect(html).toContain("foo__bar__baz");
    expect(html).not.toContain("<strong>bar</strong>");
    expect(html).toContain("2 * 3 * 4 = 24");
    expect(html).not.toContain("<em> 3 </em>");
  });

  it("renders headings, lists, task lists, nested sublists, and horizontal rules", () => {
    const md = [
      "# 主标题",
      "### 子标题 **带加粗**",
      "",
      "- 第一项",
      "  - 嵌套子项 `code`",
      "- [x] 已完成任务",
      "- [ ] 待办任务",
      "",
      "1. 第一步",
      "2. 第二步",
      "",
      "---",
    ].join("\n");

    const html = renderMd(md);
    expect(html).toContain('<h1 class="md-h md-h1">主标题</h1>');
    expect(html).toContain('<h3 class="md-h md-h3">子标题 <strong>带加粗</strong></h3>');
    expect(html).toContain('<ul class="md-ul">');
    expect(html).toContain('<ol class="md-ol">');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked=\"\"");
    expect(html).toContain('<hr class="md-hr"/>');
  });

  it("renders fenced code blocks including unclosed streaming fences", () => {
    const closedHtml = renderMd("```ts\nconst x: number = 42;\n```");
    expect(closedHtml).toContain('<span class="md-code-lang">ts</span>');
    expect(closedHtml).toContain("const x: number = 42;");

    const streamingBlocks = parseMarkdownBlocks("```python\nprint('streaming...')");
    expect(streamingBlocks).toEqual([
      { type: "code", lang: "python", code: "print('streaming...')", streaming: true },
    ]);
  });

  it("renders GFM tables even when cells contain union-type pipes inside backticks", () => {
    const md = [
      "| 字段 | 类型 | 说明 |",
      "| :--- | :---: | ---: |",
      "| `mode` | `\"auto\" | \"manual\"` | **核心配置** |",
    ].join("\n");

    const html = renderMd(md);
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('style="text-align:center"');
    expect(html).toContain('style="text-align:right"');
    expect(html).toContain('<code class="md-inline-code">&quot;auto&quot; | &quot;manual&quot;</code>');
    expect(html).toContain("<strong>核心配置</strong>");
  });

  it("renders blockquotes and GitHub alerts", () => {
    const md = "> [!WARNING]\n> 注意：**不要提交密钥**";
    const html = renderMd(md);
    expect(html).toContain("md-alert-warning");
    expect(html).toContain("WARNING");
    expect(html).toContain("<strong>不要提交密钥</strong>");
  });

  it("renders safe links and strictly neutralizes XSS payloads and unsafe schemes", () => {
    expect(isSafeUrl("https://github.com/jd04063221/agent-remote")).toBe(true);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);

    const html = renderMd(
      '[安全链接](https://example.com) [恶意](javascript:alert(1)) <script>alert("xss")</script>',
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("gracefully handles unclosed inline delimiters during streaming", () => {
    const tokens = parseInline("正在流式输出 **未闭合加粗");
    expect(tokens).toEqual([{ type: "text", text: "正在流式输出 **未闭合加粗" }]);
  });
});
