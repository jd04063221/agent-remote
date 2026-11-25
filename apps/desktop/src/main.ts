import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, Notification } from "electron";
import { AgentRemoteHub } from "@agent-remote/hub-server";

let hub: AgentRemoteHub | undefined;
let mainWindow: BrowserWindow | undefined;

function resolveWebDistDir(): string {
  const packagedWeb = path.join(process.resourcesPath ?? "", "web");
  if (app.isPackaged && fs.existsSync(packagedWeb)) {
    return packagedWeb;
  }
  return path.resolve(import.meta.dirname, "../../web/dist");
}

async function createWindow(): Promise<void> {
  const dbPath =
    process.env.AGENT_REMOTE_DB ??
    path.join(os.homedir(), ".config", "agent-remote", "hub.sqlite");
  const webDistDir = resolveWebDistDir();
  const port = Number(process.env.AGENT_REMOTE_PORT ?? 3775);

  hub = new AgentRemoteHub({ dbPath, webDistDir });
  const started = await hub.listen(port, "127.0.0.1");

  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    title: "agent-remote — Multi-Agent Control Workbench",
    backgroundColor: "#0c0f14",
    webPreferences: {
      preload: path.resolve(import.meta.dirname, "./preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await mainWindow.loadURL(started.url);

  if (Notification.isSupported()) {
    new Notification({
      title: "agent-remote Ready",
      body: `Local Hub running at ${started.url}`,
    }).show();
  }
}

void app.whenReady().then(() => {
  void createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void hub?.close();
});
