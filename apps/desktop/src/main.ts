import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  type NativeImage,
} from "electron";
import { AgentRemoteHub } from "@agent-remote/hub-server";
import { createDesktopLifecycle } from "./tray-controller.js";

function resolveWebDistDir(): string {
  const packagedWeb = path.join(process.resourcesPath ?? "", "web");
  if (app.isPackaged && fs.existsSync(packagedWeb)) {
    return packagedWeb;
  }
  return path.resolve(import.meta.dirname, "../../web/dist");
}

function resolveAssetsDir(): string {
  return path.resolve(import.meta.dirname, "../assets");
}

async function listenWithRecovery(
  hub: AgentRemoteHub,
  preferredPort: number,
  allowEphemeralFallback: boolean,
): Promise<{ url: string; port: number }> {
  try {
    return await hub.listen(preferredPort, "127.0.0.1");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EADDRINUSE") throw err;

    // Brief retry in case the user reopened immediately while Windows was still
    // releasing the previous socket on port 3775.
    await new Promise((r) => setTimeout(r, 350));
    try {
      return await hub.listen(preferredPort, "127.0.0.1");
    } catch (retryErr) {
      const retryCode = (retryErr as NodeJS.ErrnoException)?.code;
      if (!allowEphemeralFallback || retryCode !== "EADDRINUSE") {
        throw retryErr;
      }
      // Fall back to an OS-assigned loopback port so another process (e.g. CLI `ar hub`)
      // occupying 3775 never prevents the desktop GUI from opening.
      console.warn(
        `[agent-remote] Port ${preferredPort} is in use; falling back to an available local port.`,
      );
      return await hub.listen(0, "127.0.0.1");
    }
  }
}

function resolveDesktopDisplayVersion(): string {
  if (process.env.AGENT_REMOTE_VERSION?.trim()) {
    return process.env.AGENT_REMOTE_VERSION.trim().replace(/^v/i, "");
  }
  try {
    const pkgPath = path.resolve(import.meta.dirname, "../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      displayVersion?: string;
      version?: string;
    };
    if (pkg.displayVersion?.trim()) return pkg.displayVersion.trim().replace(/^v/i, "");
    if (pkg.version?.trim()) return pkg.version.trim().replace(/^v/i, "");
  } catch {
    // ignore read error
  }
  return app.getVersion() || "0.1.5a";
}

const resolvedVersion = resolveDesktopDisplayVersion();
if (!process.env.AGENT_REMOTE_VERSION && resolvedVersion) {
  process.env.AGENT_REMOTE_VERSION = resolvedVersion;
}

const lifecycle = createDesktopLifecycle({
  platform: process.platform,
  assetsDir: resolveAssetsDir(),
  version: resolvedVersion,
  app,
  async startHub() {
    const dbPath =
      process.env.AGENT_REMOTE_DB ??
      path.join(os.homedir(), ".config", "agent-remote", "hub.sqlite");
    const webDistDir = resolveWebDistDir();
    const explicitPort = Boolean(process.env.AGENT_REMOTE_PORT);
    const port = Number(process.env.AGENT_REMOTE_PORT ?? 3775);

    const hub = new AgentRemoteHub({ dbPath, webDistDir });
    try {
      const started = await listenWithRecovery(hub, port, !explicitPort);
      return {
        url: started.url,
        close: () => hub.close(),
      };
    } catch (err) {
      await hub.close().catch(() => {});
      throw err;
    }
  },
  createBrowserWindow({ title, icon }) {
    return new BrowserWindow({
      width: 1460,
      height: 920,
      minWidth: 1080,
      minHeight: 680,
      title,
      icon: icon as NativeImage | undefined,
      backgroundColor: "#0c0f14",
      webPreferences: {
        preload: path.resolve(import.meta.dirname, "./preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
  },
  createTray(icon) {
    return new Tray(icon as NativeImage);
  },
  buildMenu(template) {
    return Menu.buildFromTemplate(template);
  },
  loadNativeImageFromPath(filePath) {
    return nativeImage.createFromPath(filePath);
  },
  loadNativeImageFromBuffer(buffer) {
    return nativeImage.createFromBuffer(buffer);
  },
  openExternal(url) {
    return shell.openExternal(url);
  },
  notify({ title, body }) {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  },
  logger: console,
});

process.on("SIGINT", () => lifecycle.requestQuit());
process.on("SIGTERM", () => lifecycle.requestQuit());

lifecycle.start();
