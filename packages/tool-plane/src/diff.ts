/**
 * Produces a concise unified diff between two text snapshots for UI diff rendering and approval cards.
 */
export function createUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  contextLines = 3,
): string {
  if (before === after) return "";

  const aLines = before === "" ? [] : before.split(/\r?\n/);
  const bLines = after === "" ? [] : after.split(/\r?\n/);

  // Trim shared prefix/suffix for O(diff) performance on large files
  let start = 0;
  while (
    start < aLines.length &&
    start < bLines.length &&
    aLines[start] === bLines[start]
  ) {
    start++;
  }

  let endA = aLines.length - 1;
  let endB = bLines.length - 1;
  while (endA >= start && endB >= start && aLines[endA] === bLines[endB]) {
    endA--;
    endB--;
  }

  const ctxStart = Math.max(0, start - contextLines);
  const ctxEndA = Math.min(aLines.length - 1, endA + contextLines);
  const ctxEndB = Math.min(bLines.length - 1, endB + contextLines);

  const oldCount = ctxEndA >= ctxStart ? ctxEndA - ctxStart + 1 : 0;
  const newCount = ctxEndB >= ctxStart ? ctxEndB - ctxStart + 1 : 0;

  const out: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${ctxStart + 1},${oldCount} +${ctxStart + 1},${newCount} @@`,
  ];

  for (let i = ctxStart; i < start; i++) {
    out.push(` ${aLines[i] ?? ""}`);
  }
  for (let i = start; i <= endA; i++) {
    out.push(`-${aLines[i] ?? ""}`);
  }
  for (let i = start; i <= endB; i++) {
    out.push(`+${bLines[i] ?? ""}`);
  }
  for (let i = endA + 1; i <= ctxEndA; i++) {
    out.push(` ${aLines[i] ?? ""}`);
  }

  return out.join("\n");
}
