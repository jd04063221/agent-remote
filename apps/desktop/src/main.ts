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

if (!process.env.AGENT_REMOTE_VERSION && app.getVersion()) {
  process.env.AGENT_REMOTE_VERSION = app.getVersion();
}

const lifecycle = createDesktopLifecycle({
  platform: process.platform,
  assetsDir: resolveAssetsDir(),
  version: process.env.AGENT_REMOTE_VERSION || app.getVersion(),
  app,
  async startHub() {
    const dbPath =
      process.env.AGENT_REMOTE_DB ??
      path.join(os.homedir(), ".config", "agent-remote", "hub.sqlite");
    const webDistDir = resolveWebDistDir();
    const port = Number(process.env.AGENT_REMOTE_PORT ?? 3775);

    const hub = new AgentRemoteHub({ dbPath, webDistDir });
    const started = await hub.listen(port, "127.0.0.1");
    return {
      url: started.url,
      close: () => hub.close(),
    };
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
