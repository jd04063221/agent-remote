import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("agentRemoteDesktop", {
  platform: process.platform,
  version: "0.1.5",
});
