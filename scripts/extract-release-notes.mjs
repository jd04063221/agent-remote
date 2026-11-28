#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function runGit(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function parseSemver(tag) {
  const m = tag.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)([a-zA-Z][0-9a-zA-Z]*)?(?:-(.+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    letter: m[4] ?? "",
    pre: m[5] ?? "",
  };
}

function compareSemverDesc(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return b.localeCompare(a);
  if (!pa) return 1;
  if (!pb) return -1;
  if (pa.major !== pb.major) return pb.major - pa.major;
  if (pa.minor !== pb.minor) return pb.minor - pa.minor;
  if (pa.patch !== pb.patch) return pb.patch - pa.patch;
  if (pa.letter !== pb.letter) {
    if (!pa.letter) return 1;
    if (!pb.letter) return -1;
    return pb.letter.localeCompare(pa.letter);
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return -1;
  if (!pb.pre) return 1;
  return pb.pre.localeCompare(pa.pre);
}

function findPreviousTag(currentTag) {
  const raw = runGit(["tag", "-l", "v*"]);
  if (!raw) return "";
  const tags = raw
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .sort(compareSemverDesc);

  const curSem = parseSemver(currentTag);
  for (const tag of tags) {
    if (tag === currentTag) continue;
    if (curSem) {
      if (compareSemverDesc(currentTag, tag) < 0) {
        return tag;
      }
    } else {
      return tag;
    }
  }
  return "";
}

function extractChangelogSection(changelogText, tag) {
  const bare = tag.replace(/^v/, "");
  const escapedBare = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(
    `^##\\s+\\[?v?${escapedBare}\\]?(?:\\s+-\\s+.*)?\\s*$`,
    "m",
  );
  const match = headerRe.exec(changelogText);
  if (!match) return "";

  const startIdx = match.index + match[0].length;
  const rest = changelogText.slice(startIdx);
  const nextSectionRe = /\r?\n(?:##\s+|\[[^\]]+\]:\s+https?:\/\/)/;
  const nextMatch = nextSectionRe.exec(rest);
  const body = nextMatch ? rest.slice(0, nextMatch.index) : rest;
  return body.trim();
}

function collectCommits(prevTag, currentTag) {
  const targetRef = runGit(["rev-parse", "--verify", `${currentTag}^{commit}`])
    ? currentTag
    : "HEAD";
  const range = prevTag ? `${prevTag}..${targetRef}` : targetRef;
  const out = runGit(["log", "--no-merges", "--format=%h%x09%s", range]);
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((line) => {
      const [hash, ...rest] = line.split("\t");
      return { hash: hash?.trim() ?? "", subject: rest.join("\t").trim() };
    })
    .filter(
      (c) =>
        c.hash &&
        c.subject &&
        !/^chore\(release\):\s*bump version/i.test(c.subject),
    );
}

function buildFallbackNotesFromCommits(commits, repo) {
  if (commits.length === 0) {
    return "本版本主要包含版本打包与常规维护更新。";
  }

  const buckets = {
    added: [],
    fixed: [],
    changed: [],
    other: [],
  };

  for (const c of commits) {
    const line = `- ${c.subject} ([\`${c.hash}\`](https://github.com/${repo}/commit/${c.hash}))`;
    if (/^feat(?:\([^)]*\))?!?:/i.test(c.subject)) {
      buckets.added.push(line);
    } else if (/^fix(?:\([^)]*\))?!?:/i.test(c.subject)) {
      buckets.fixed.push(line);
    } else if (/^(?:perf|refactor)(?:\([^)]*\))?!?:/i.test(c.subject)) {
      buckets.changed.push(line);
    } else {
      buckets.other.push(line);
    }
  }

  const sections = [];
  if (buckets.added.length) {
    sections.push(`### 新增（Added）\n${buckets.added.join("\n")}`);
  }
  if (buckets.fixed.length) {
    sections.push(`### 修复（Fixed）\n${buckets.fixed.join("\n")}`);
  }
  if (buckets.changed.length) {
    sections.push(`### 优化与重构（Changed）\n${buckets.changed.join("\n")}`);
  }
  if (buckets.other.length) {
    sections.push(`### 文档、构建与其他（Other）\n${buckets.other.join("\n")}`);
  }
  return sections.join("\n\n");
}

function main() {
  const tag = getArg("--tag") || process.env.RELEASE_TAG || "";
  if (!tag) {
    console.error("Usage: node scripts/extract-release-notes.mjs --tag vX.Y.Z [--repo owner/name] [--out file]");
    process.exit(1);
  }
  const repo =
    getArg("--repo") || process.env.GITHUB_REPOSITORY || "jd04063221/agent-remote";
  const outPath = getArg("--out");
  const changelogPath = getArg(
    "--changelog",
    path.resolve(process.cwd(), "CHANGELOG.md"),
  );

  const standalone = process.argv.includes("--standalone");
  const prevTag = standalone ? "" : findPreviousTag(tag);
  const commits = standalone ? [] : collectCommits(prevTag, tag);

  let changelogBody = "";
  if (fs.existsSync(changelogPath)) {
    const raw = fs.readFileSync(changelogPath, "utf8");
    changelogBody = extractChangelogSection(raw, tag);
  }

  const parts = [];
  if (prevTag) {
    parts.push(
      `> 本版本（\`${tag}\`）相比上一版本 [\`${prevTag}\`](https://github.com/${repo}/releases/tag/${prevTag}) 的主要改进与修复如下。`,
    );
  } else {
    parts.push(`> \`${tag}\` 版本主要内容如下。`);
  }

  if (changelogBody) {
    parts.push(changelogBody);
  } else {
    parts.push(buildFallbackNotesFromCommits(commits, repo));
  }

  if (commits.length > 0 && changelogBody) {
    const commitLines = commits.map(
      (c) =>
        `- ${c.subject} ([\`${c.hash}\`](https://github.com/${repo}/commit/${c.hash}))`,
    );
    const title = prevTag
      ? `查看相对 ${prevTag} 的全部 ${commits.length} 条提交记录`
      : `查看本版本全部 ${commits.length} 条提交记录`;
    parts.push(
      `<details>\n<summary>${title}</summary>\n\n${commitLines.join("\n")}\n\n</details>`,
    );
  }

  if (prevTag) {
    parts.push(
      `**完整代码变更对比**：[\`${prevTag}...${tag}\`](https://github.com/${repo}/compare/${prevTag}...${tag})`,
    );
  }

  const markdown = `${parts.join("\n\n")}\n`;
  if (outPath) {
    fs.writeFileSync(outPath, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
}

main();
