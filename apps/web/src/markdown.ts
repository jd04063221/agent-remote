export type TableAlign = "left" | "center" | "right" | null;

export type MdInline =
  | { type: "text"; text: string }
  | { type: "br" }
  | { type: "code"; text: string; title?: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "del"; children: MdInline[] }
  | { type: "link"; href: string; children: MdInline[] };

export interface MdListItem {
  checked?: boolean;
  inline: MdInline[];
  children: MdBlock[];
}

export type MdAlertKind = "note" | "tip" | "important" | "warning" | "caution";

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { type: "paragraph"; children: MdInline[] }
  | { type: "code"; lang: string; code: string; streaming?: boolean }
  | { type: "blockquote"; alert?: MdAlertKind; children: MdBlock[] }
  | { type: "list"; ordered: boolean; start: number; items: MdListItem[] }
  | { type: "table"; alignments: TableAlign[]; headers: MdInline[][]; rows: MdInline[][][] }
  | { type: "hr" };

const ESCAPABLE_ASCII = /^[\\`*_{}[\]()#+\-.!~|><]/;
const WORD_CHAR = /[A-Za-z0-9_]/;
const SAFE_URL_RE = /^(?:https?:\/\/|mailto:)/i;
const HR_RE = /^\s{0,3}(?:(\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const HEADING_RE = /^\s{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*).*$/;
const BLOCKQUOTE_RE = /^\s{0,3}>[ \t]?(.*)$/;
const UL_ITEM_RE = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const OL_ITEM_RE = /^([ \t]*)(\d{1,9})\.[ \t]+(.*)$/;
const TASK_RE = /^\[( |x|X)\][ \t]+(.*)$/;
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TABLE_SEP_SINGLE_RE = /^\s*\|\s*:?-{3,}:?\s*\|\s*$/;

export function isSafeUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return SAFE_URL_RE.test(trimmed);
}

function decodeFileUri(uri: string): string {
  const stripped = uri.replace(/^file:\/\//i, "");
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function expandTabs(str: string): number {
  let width = 0;
  for (const ch of str) {
    width += ch === "\t" ? 2 : 1;
  }
  return width;
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);

  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  let codeTicks = 0;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (!inCode && ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (s[i + run] === "`") run++;
      if (!inCode) {
        inCode = true;
        codeTicks = run;
      } else if (run === codeTicks) {
        inCode = false;
        codeTicks = 0;
      }
      cur += "`".repeat(run);
      i += run - 1;
      continue;
    }
    if (!inCode && ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableDelimiterLine(line: string): boolean {
  return TABLE_SEP_RE.test(line) || TABLE_SEP_SINGLE_RE.test(line);
}

function parseTableAlignments(line: string): TableAlign[] {
  return splitTableRow(line).map((cell) => {
    const c = cell.trim();
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

function isTableStart(lines: string[], idx: number): boolean {
  if (idx + 1 >= lines.length) return false;
  const header = lines[idx]!;
  const sep = lines[idx + 1]!;
  if (!header.includes("|")) return false;
  if (!isTableDelimiterLine(sep)) return false;
  const headerCells = splitTableRow(header);
  const sepCells = splitTableRow(sep);
  return headerCells.length > 0 && headerCells.length === sepCells.length;
}

function isBlockStarter(lines: string[], idx: number): boolean {
  const line = lines[idx]!;
  if (line.trim() === "") return true;
  if (FENCE_OPEN_RE.test(line)) return true;
  if (HEADING_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (BLOCKQUOTE_RE.test(line)) return true;
  if (UL_ITEM_RE.test(line) || OL_ITEM_RE.test(line)) return true;
  if (isTableStart(lines, idx)) return true;
  return false;
}

function stripIndent(line: string, indent: number): string {
  let removed = 0;
  let i = 0;
  while (i < line.length && removed < indent) {
    if (line[i] === " ") {
      removed += 1;
      i++;
    } else if (line[i] === "\t") {
      removed += 2;
      i++;
    } else {
      break;
    }
  }
  return line.slice(i);
}

export function parseMarkdownBlocks(input: string): MdBlock[] {
  const normalized = input.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  return parseLines(lines);
}

function parseLines(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block (supports streaming unclosed fences)
    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen) {
      const marker = fenceOpen[1]!;
      const fenceChar = marker[0]!;
      const fenceLen = marker.length;
      const lang = (fenceOpen[2] ?? "").trim();
      const closeRe = new RegExp(`^\\s{0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
      const codeLines: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (closeRe.test(lines[i]!)) {
          closed = true;
          i++;
          break;
        }
        codeLines.push(lines[i]!);
        i++;
      }
      blocks.push({
        type: "code",
        lang,
        code: codeLines.join("\n"),
        streaming: !closed,
      });
      continue;
    }

    // ATX Heading
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      const content = (heading[2] ?? "").trim();
      blocks.push({
        type: "heading",
        level,
        children: parseInline(content),
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Blockquote (with optional GitHub alert header)
    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const m = BLOCKQUOTE_RE.exec(lines[i]!);
        if (!m) break;
        quoteLines.push(m[1]!);
        i++;
      }
      let alert: MdAlertKind | undefined;
      if (quoteLines.length > 0) {
        const alertMatch = ALERT_RE.exec(quoteLines[0]!.trim());
        if (alertMatch) {
          alert = alertMatch[1]!.toLowerCase() as MdAlertKind;
          quoteLines.shift();
        }
      }
      blocks.push({
        type: "blockquote",
        alert,
        children: parseLines(quoteLines),
      });
      continue;
    }

    // GFM Table
    if (isTableStart(lines, i)) {
      const headerCells = splitTableRow(lines[i]!);
      const alignments = parseTableAlignments(lines[i + 1]!);
      const colCount = alignments.length;
      const rows: MdInline[][][] = [];
      i += 2;
      while (i < lines.length) {
        const rowLine = lines[i]!;
        if (rowLine.trim() === "" || !rowLine.includes("|")) break;
        if (FENCE_OPEN_RE.test(rowLine) || HEADING_RE.test(rowLine)) break;
        const rawCells = splitTableRow(rowLine);
        const normalizedRow: MdInline[][] = [];
        for (let c = 0; c < colCount; c++) {
          normalizedRow.push(parseInline(rawCells[c] ?? ""));
        }
        rows.push(normalizedRow);
        i++;
      }
      blocks.push({
        type: "table",
        alignments,
        headers: headerCells.map((cell) => parseInline(cell)),
        rows,
      });
      continue;
    }

    // Ordered / Unordered List
    const ulMatch = UL_ITEM_RE.exec(line);
    const olMatch = !ulMatch ? OL_ITEM_RE.exec(line) : null;
    if (ulMatch || olMatch) {
      const ordered = Boolean(olMatch);
      const baseIndent = expandTabs((ulMatch ?? olMatch)![1]!);
      const start = olMatch ? Number(olMatch[2]) : 1;
      const items: MdListItem[] = [];

      while (i < lines.length) {
        const curLine = lines[i]!;
        if (curLine.trim() === "") {
          // Check if another list item of the same kind & indent follows blank lines
          let peek = i + 1;
          while (peek < lines.length && lines[peek]!.trim() === "") peek++;
          if (peek >= lines.length) break;
          const nextMatch = ordered
            ? OL_ITEM_RE.exec(lines[peek]!)
            : UL_ITEM_RE.exec(lines[peek]!);
          if (nextMatch && expandTabs(nextMatch[1]!) === baseIndent) {
            i = peek;
            continue;
          }
          break;
        }

        const itemMatch = ordered ? OL_ITEM_RE.exec(curLine) : UL_ITEM_RE.exec(curLine);
        if (!itemMatch || expandTabs(itemMatch[1]!) !== baseIndent) {
          break;
        }

        let firstText = itemMatch[3]!;
        let checked: boolean | undefined;
        if (!ordered) {
          const taskMatch = TASK_RE.exec(firstText);
          if (taskMatch) {
            checked = taskMatch[1]!.toLowerCase() === "x";
            firstText = taskMatch[2]!;
          }
        }

        i++;
        const subLines: string[] = [];
        const inlineLines: string[] = [firstText];
        let inNestedBlock = false;
        let inSubFence = false;
        let subFenceCloseRe: RegExp | null = null;

        while (i < lines.length) {
          const next = lines[i]!;
          if (inSubFence) {
            const stripped = stripIndent(next, baseIndent + 2);
            subLines.push(stripped);
            if (subFenceCloseRe && subFenceCloseRe.test(stripped)) {
              inSubFence = false;
              subFenceCloseRe = null;
            }
            i++;
            continue;
          }

          if (next.trim() === "") {
            // Look ahead to see if indented continuation belongs to this item
            let peek = i + 1;
            while (peek < lines.length && lines[peek]!.trim() === "") peek++;
            if (peek < lines.length) {
              const peekIndent = expandTabs(lines[peek]!.match(/^[ \t]*/)![0]!);
              if (peekIndent > baseIndent) {
                inNestedBlock = true;
                subLines.push("");
                i++;
                continue;
              }
            }
            break;
          }

          const nextIndent = expandTabs(next.match(/^[ \t]*/)![0]!);
          const sameLevelUl = UL_ITEM_RE.exec(next);
          const sameLevelOl = OL_ITEM_RE.exec(next);
          if (
            (sameLevelUl && expandTabs(sameLevelUl[1]!) <= baseIndent) ||
            (sameLevelOl && expandTabs(sameLevelOl[1]!) <= baseIndent)
          ) {
            break;
          }

          if (nextIndent > baseIndent) {
            const stripped = stripIndent(next, Math.min(nextIndent, baseIndent + 2));
            const fenceInItem = FENCE_OPEN_RE.exec(stripped);
            if (
              inNestedBlock ||
              fenceInItem ||
              UL_ITEM_RE.test(stripped) ||
              OL_ITEM_RE.test(stripped) ||
              BLOCKQUOTE_RE.test(stripped) ||
              HEADING_RE.test(stripped)
            ) {
              inNestedBlock = true;
              subLines.push(stripped);
              if (fenceInItem) {
                const mk = fenceInItem[1]!;
                inSubFence = true;
                subFenceCloseRe = new RegExp(`^\\s{0,3}${mk[0]}{${mk.length},}[ \\t]*$`);
              }
            } else {
              inlineLines.push(next.trim());
            }
            i++;
            continue;
          }

          // Unindented non-starter continuation line inside a tight list item
          if (!isBlockStarter(lines, i)) {
            inlineLines.push(next.trim());
            i++;
            continue;
          }
          break;
        }

        items.push({
          checked,
          inline: parseInline(inlineLines.join("\n")),
          children: subLines.length > 0 ? parseLines(subLines) : [],
        });
      }

      blocks.push({
        type: "list",
        ordered,
        start,
        items,
      });
      continue;
    }

    // Paragraph (preserve soft single line breaks)
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && !isBlockStarter(lines, i)) {
      paraLines.push(lines[i]!);
      i++;
    }
    blocks.push({
      type: "paragraph",
      children: parseInline(paraLines.join("\n")),
    });
  }

  return blocks;
}

/**
 * Finds the end index of an inline code span starting at `start` (which points to `` ` ``).
 * Returns index immediately after the closing backtick run, or -1 if unclosed.
 */
function findCodeSpanEnd(text: string, start: number): { end: number; tickLen: number } | null {
  let tickLen = 0;
  while (text[start + tickLen] === "`") tickLen++;
  let j = start + tickLen;
  while (j < text.length) {
    if (text[j] === "`") {
      let run = 0;
      while (text[j + run] === "`") run++;
      if (run === tickLen) {
        return { end: j + run, tickLen };
      }
      j += run;
      continue;
    }
    j++;
  }
  return null;
}

/**
 * Finds a matching closing delimiter (`**`, `***`, `~~`, `__`, `*`, `_`) starting from `from`,
 * skipping escaped chars and inline code spans.
 * For `**`, if a `***` run is encountered, consumes the trailing `**` so inner `*italic*` can close cleanly.
 */
function findClosingDelimiter(
  text: string,
  from: number,
  delim: string,
  requireOuterWordBoundary: boolean,
): number {
  const ch = delim[0]!;
  const len = delim.length;
  let j = from;

  while (j < text.length) {
    const cur = text[j]!;
    if (cur === "\\" && j + 1 < text.length) {
      j += 2;
      continue;
    }
    if (cur === "`") {
      const span = findCodeSpanEnd(text, j);
      if (span) {
        j = span.end;
        continue;
      }
      while (text[j] === "`") j++;
      continue;
    }
    if (cur === ch) {
      let run = 0;
      while (text[j + run] === ch) run++;
      const runEnd = j + run;

      // Exact match, or trailing `**` inside `***` (so `**bold *italic***` works)
      let closePos = -1;
      if (run === len) {
        closePos = j;
      } else if (delim === "**" && run === 3) {
        closePos = runEnd - 2;
      } else if (delim === "*" && run === 3) {
        closePos = runEnd - 1;
      }

      if (closePos > from && !isWhitespace(text[closePos - 1])) {
        const after = text[closePos + len];
        if (!requireOuterWordBoundary || !after || !WORD_CHAR.test(after)) {
          return closePos;
        }
      }
      j = runEnd;
      continue;
    }
    j++;
  }
  return -1;
}

function parseLinkAt(
  text: string,
  start: number,
): { label: string; href: string; end: number } | null {
  if (text[start] !== "[") return null;
  // Find matching ] allowing nested brackets and code spans
  let j = start + 1;
  let depth = 1;
  while (j < text.length && depth > 0) {
    if (text[j] === "\\" && j + 1 < text.length) {
      j += 2;
      continue;
    }
    if (text[j] === "`") {
      const span = findCodeSpanEnd(text, j);
      if (span) {
        j = span.end;
        continue;
      }
    }
    if (text[j] === "[") depth++;
    else if (text[j] === "]") depth--;
    j++;
  }
  if (depth !== 0) return null;
  const labelEnd = j - 1;
  if (text[j] !== "(") return null;

  // Find matching ) allowing balanced parens inside URL
  let k = j + 1;
  let parenDepth = 1;
  while (k < text.length && parenDepth > 0) {
    if (text[k] === "\\" && k + 1 < text.length) {
      k += 2;
      continue;
    }
    if (text[k] === "\n") return null;
    if (text[k] === "(") parenDepth++;
    else if (text[k] === ")") parenDepth--;
    k++;
  }
  if (parenDepth !== 0) return null;

  const rawDest = text.slice(j + 1, k - 1).trim();
  // Strip optional title: `url "title"` or `<url>`
  let href = rawDest;
  if (href.startsWith("<")) {
    const closeAngle = href.indexOf(">");
    if (closeAngle !== -1) href = href.slice(1, closeAngle).trim();
  } else {
    const spaceIdx = href.search(/\s/);
    if (spaceIdx !== -1) href = href.slice(0, spaceIdx);
  }

  return {
    label: text.slice(start + 1, labelEnd),
    href,
    end: k,
  };
}

function pushText(nodes: MdInline[], str: string): void {
  if (!str) return;
  const prev = nodes[nodes.length - 1];
  if (prev && prev.type === "text") {
    prev.text += str;
  } else {
    nodes.push({ type: "text", text: str });
  }
}

export function parseInline(text: string): MdInline[] {
  const nodes: MdInline[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    // Soft line break
    if (ch === "\n") {
      nodes.push({ type: "br" });
      i++;
      continue;
    }

    // Backslash escape for ASCII punctuation
    if (ch === "\\" && i + 1 < text.length && ESCAPABLE_ASCII.test(text[i + 1]!)) {
      pushText(nodes, text[i + 1]!);
      i += 2;
      continue;
    }

    // Inline code span
    if (ch === "`") {
      const span = findCodeSpanEnd(text, i);
      if (span) {
        let content = text.slice(i + span.tickLen, span.end - span.tickLen);
        if (
          content.length >= 2 &&
          content.startsWith(" ") &&
          content.endsWith(" ") &&
          content.trim().length > 0
        ) {
          content = content.slice(1, -1);
        }
        nodes.push({ type: "code", text: content });
        i = span.end;
        continue;
      }
      // Unclosed backticks (e.g., mid-stream)
      let run = 0;
      while (text[i + run] === "`") run++;
      pushText(nodes, "`".repeat(run));
      i += run;
      continue;
    }

    // Angle-bracket autolink <https://...>
    if (ch === "<") {
      const close = text.indexOf(">", i + 1);
      if (close !== -1) {
        const inner = text.slice(i + 1, close);
        if (!/\s/.test(inner) && isSafeUrl(inner)) {
          nodes.push({
            type: "link",
            href: inner,
            children: [{ type: "text", text: inner }],
          });
          i = close + 1;
          continue;
        }
      }
    }

    // Markdown link [label](url)
    if (ch === "[") {
      const link = parseLinkAt(text, i);
      if (link) {
        const labelNodes = parseInline(link.label);
        if (isSafeUrl(link.href)) {
          nodes.push({
            type: "link",
            href: link.href,
            children: labelNodes.length > 0 ? labelNodes : [{ type: "text", text: link.href }],
          });
        } else if (/^file:\/\//i.test(link.href.trim())) {
          // Safe, readable badge for local file:// citations emitted by agents (e.g. [App.tsx](file:///.../App.tsx#L10))
          const cleanPath = decodeFileUri(link.href.trim());
          nodes.push({
            type: "code",
            text: link.label.trim() || cleanPath,
            title: cleanPath,
          });
        } else {
          // Safe fallback for blocked schemes (e.g. javascript:, data:)
          for (const n of labelNodes) nodes.push(n);
        }
        i = link.end;
        continue;
      }
    }

    // Bare HTTP(S) autolink
    if (
      (text.startsWith("https://", i) || text.startsWith("http://", i)) &&
      (i === 0 || !WORD_CHAR.test(text[i - 1]!))
    ) {
      let j = i;
      let parenDepth = 0;
      while (j < text.length) {
        const c = text[j]!;
        if (/[\s<>"'`，。；：！？（）【】《》、]/.test(c)) break;
        if (c === "(") parenDepth++;
        else if (c === ")") {
          if (parenDepth === 0) break;
          parenDepth--;
        }
        j++;
      }
      // Trim trailing sentence punctuation
      while (j > i && /[.,;:!?]$/.test(text[j - 1]!)) {
        j--;
      }
      const url = text.slice(i, j);
      if (url.length > 8 && isSafeUrl(url)) {
        nodes.push({
          type: "link",
          href: url,
          children: [{ type: "text", text: url }],
        });
        i = j;
        continue;
      }
    }

    // Bold + Italic ***...***
    if (text.startsWith("***", i) && !isWhitespace(text[i + 3])) {
      const close = findClosingDelimiter(text, i + 3, "***", false);
      if (close !== -1) {
        const inner = text.slice(i + 3, close);
        nodes.push({
          type: "strong",
          children: [{ type: "em", children: parseInline(inner) }],
        });
        i = close + 3;
        continue;
      }
    }

    // Bold **...** (CJK punctuation friendly — no restrictive CommonMark flanking rule)
    if (text.startsWith("**", i) && !text.startsWith("***", i) && !isWhitespace(text[i + 2])) {
      const close = findClosingDelimiter(text, i + 2, "**", false);
      if (close !== -1) {
        const inner = text.slice(i + 2, close);
        nodes.push({
          type: "strong",
          children: parseInline(inner),
        });
        i = close + 2;
        continue;
      }
    }

    // Bold __...__ (strict outer word boundary so snake_case / __dunder__ inside words stay intact)
    if (
      text.startsWith("__", i) &&
      !text.startsWith("___", i) &&
      !isWhitespace(text[i + 2]) &&
      (i === 0 || !WORD_CHAR.test(text[i - 1]!))
    ) {
      const close = findClosingDelimiter(text, i + 2, "__", true);
      if (close !== -1) {
        const inner = text.slice(i + 2, close);
        nodes.push({
          type: "strong",
          children: parseInline(inner),
        });
        i = close + 2;
        continue;
      }
    }

    // Strikethrough ~~...~~
    if (text.startsWith("~~", i) && !isWhitespace(text[i + 2])) {
      const close = findClosingDelimiter(text, i + 2, "~~", false);
      if (close !== -1) {
        const inner = text.slice(i + 2, close);
        nodes.push({
          type: "del",
          children: parseInline(inner),
        });
        i = close + 2;
        continue;
      }
    }

    // Italic *...*
    if (ch === "*" && text[i + 1] !== "*" && !isWhitespace(text[i + 1])) {
      const close = findClosingDelimiter(text, i + 1, "*", false);
      if (close !== -1) {
        const inner = text.slice(i + 1, close);
        nodes.push({
          type: "em",
          children: parseInline(inner),
        });
        i = close + 1;
        continue;
      }
    }

    // Italic _..._ (strict outer word boundary so snake_case identifiers stay intact)
    if (
      ch === "_" &&
      text[i + 1] !== "_" &&
      !isWhitespace(text[i + 1]) &&
      (i === 0 || !WORD_CHAR.test(text[i - 1]!))
    ) {
      const close = findClosingDelimiter(text, i + 1, "_", true);
      if (close !== -1) {
        const inner = text.slice(i + 1, close);
        nodes.push({
          type: "em",
          children: parseInline(inner),
        });
        i = close + 1;
        continue;
      }
    }

    pushText(nodes, ch);
    i++;
  }

  return nodes;
}
