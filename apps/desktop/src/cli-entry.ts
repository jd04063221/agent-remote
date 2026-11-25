import fs from "node:fs";
import path from "node:path";

// Point `ar ui` / `ar hub` to the bundled web assets inside the packaged Desktop app.
const packagedWeb = path.resolve(import.meta.dirname, "../../web");
if (!process.env.AGENT_REMOTE_WEB_DIST && fs.existsSync(packagedWeb)) {
  process.env.AGENT_REMOTE_WEB_DIST = packagedWeb;
}

if (!process.env.AGENT_REMOTE_VERSION) {
  try {
    const pkgPath = path.resolve(import.meta.dirname, "../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) {
      process.env.AGENT_REMOTE_VERSION = pkg.version;
    }
  } catch {
    // ignore version read error
  }
}

await import("agent-remote/cli");
