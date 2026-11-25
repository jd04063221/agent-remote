/**
 * Describes the local workstation's OS and shell so remote agents running on a different OS
 * (e.g. Linux remote brain -> Windows local PowerShell) generate compatible commands and paths.
 */
export function describeLocalRuntimeEnv(
  platform: string = process.platform,
  arch: string = process.arch,
  env: Record<string, string | undefined> = process.env,
): string {
  const customShell = env.AGENT_REMOTE_SHELL?.trim();
  if (platform === "win32") {
    const shellLabel = customShell || "PowerShell";
    return `Windows (${arch}), local shell: ${shellLabel} (use PowerShell syntax — use ';' instead of '&&' for compatibility with Windows PowerShell 5.1, use '$env:VAR="val"' instead of 'VAR=val cmd', and avoid Unix-only utilities unless installed)`;
  }
  const osLabel = platform === "darwin" ? "macOS" : "Linux";
  const shellLabel = customShell || "bash";
  return `${osLabel} (${arch}), local shell: ${shellLabel}`;
}
