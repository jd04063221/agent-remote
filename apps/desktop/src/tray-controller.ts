import fs from "node:fs";
import path from "node:path";

export interface CloseEventLike {
  preventDefault(): void;
}

export interface NativeImageLike {
  isEmpty(): boolean;
  setTemplateImage?(option: boolean): void;
}

export interface MenuItemSpec {
  label?: string;
  type?: "normal" | "separator";
  enabled?: boolean;
  click?: () => void;
}

export interface TrayLike {
  setToolTip(toolTip: string): void;
  setContextMenu(menu: unknown): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface BrowserWindowLike {
  loadURL(url: string): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
  show(): void;
  hide(): void;
  focus(): void;
  restore(): void;
  isVisible(): boolean;
  isMinimized(): boolean;
  isDestroyed(): boolean;
  isFullScreen?(): boolean;
  setFullScreen?(flag: boolean): void;
}

export interface AppLike {
  getVersion?(): string;
  getLocale?(): string;
  requestSingleInstanceLock?(): boolean;
  setAppUserModelId?(id: string): void;
  whenReady(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  focus?(options?: { steal?: boolean }): void;
  quit(): void;
}

export interface HubHandle {
  url: string;
  close(): Promise<void>;
}

export interface DesktopLifecycleDeps {
  platform: NodeJS.Platform;
  assetsDir: string;
  version?: string;
  app: AppLike;
  startHub: () => Promise<HubHandle>;
  createBrowserWindow: (options: {
    title: string;
    icon?: NativeImageLike;
  }) => BrowserWindowLike;
  createTray: (icon: NativeImageLike) => TrayLike;
  buildMenu: (template: MenuItemSpec[]) => unknown;
  loadNativeImageFromPath: (filePath: string) => NativeImageLike;
  loadNativeImageFromBuffer: (buffer: Buffer) => NativeImageLike;
  openExternal: (url: string) => Promise<void> | void;
  notify?: (options: { title: string; body: string }) => void;
  logger?: { warn: (...args: unknown[]) => void };
  shutdownTimeoutMs?: number;
}

export interface DesktopLifecycleController {
  start(): void;
  showMainWindow(): void;
  hideMainWindowToTray(notifyFirstTime?: boolean): void;
  requestQuit(): void;
  isQuitting(): boolean;
  getHubUrl(): string | undefined;
  getTray(): TrayLike | undefined;
  getMainWindow(): BrowserWindowLike | undefined;
}

/**
 * Valid 1x1 cyan RGBA PNG used only as a last-resort fallback if the on-disk
 * assets directory was manually deleted, ensuring `new Tray(...)` never fails
 * with an empty image.
 */
const FALLBACK_TRAY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEfQHzbpFsPDAAAAAElFTkSuQmCC";

export const APP_USER_MODEL_ID = "io.github.jd04063221.agent-remote";

export interface TrayStrings {
  showWindow: string;
  hideToTray: string;
  openInBrowser: string;
  quit: string;
  readyTitle: string;
  readyBody: (url: string) => string;
  minimizedTitle: string;
  minimizedBody: string;
}

export function getTrayStrings(platform: NodeJS.Platform, locale = ""): TrayStrings {
  const isZh = locale.toLowerCase().startsWith("zh");
  const isMac = platform === "darwin";

  if (isZh) {
    return {
      showWindow: "显示主窗口",
      hideToTray: isMac ? "隐藏到状态栏" : "隐藏到系统托盘",
      openInBrowser: "在浏览器中打开 Web UI",
      quit: "退出 agent-remote",
      readyTitle: "agent-remote 已就绪",
      readyBody: (url) => `本地 Hub 正在运行：${url}`,
      minimizedTitle: "agent-remote 已转入后台运行",
      minimizedBody: isMac
        ? "窗口已隐藏至顶部状态栏，点击状态栏图标可重新打开或退出。"
        : "窗口已最小化至系统托盘，右键点击托盘图标可重新打开或完全退出。",
    };
  }

  return {
    showWindow: "Show Window",
    hideToTray: isMac ? "Hide to Menu Bar" : "Hide to Tray",
    openInBrowser: "Open Web UI in Browser",
    quit: "Quit agent-remote",
    readyTitle: "agent-remote Ready",
    readyBody: (url) => `Local Hub running at ${url}`,
    minimizedTitle: "agent-remote is running in the background",
    minimizedBody: isMac
      ? "Closed to the menu bar. Click the status bar icon to reopen or quit."
      : "Minimized to the system tray. Right-click the tray icon to reopen or quit.",
  };
}

export function resolveTrayIcon(
  deps: Pick<
    DesktopLifecycleDeps,
    "platform" | "assetsDir" | "loadNativeImageFromPath" | "loadNativeImageFromBuffer"
  >,
): NativeImageLike {
  const candidates =
    deps.platform === "darwin"
      ? ["tray-icon-Template.png", "tray-icon.png"]
      : deps.platform === "win32"
        ? ["tray-icon.ico", "tray-icon.png", "icon.ico", "icon.png"]
        : ["tray-icon.png", "icon.png"];

  for (const filename of candidates) {
    const fullPath = path.join(deps.assetsDir, filename);
    if (!fs.existsSync(fullPath)) continue;
    const img = deps.loadNativeImageFromPath(fullPath);
    if (img && !img.isEmpty()) {
      if (deps.platform === "darwin") {
        img.setTemplateImage?.(true);
      }
      return img;
    }
  }

  const fallback = deps.loadNativeImageFromBuffer(
    Buffer.from(FALLBACK_TRAY_PNG_BASE64, "base64"),
  );
  if (deps.platform === "darwin") {
    fallback.setTemplateImage?.(true);
  }
  return fallback;
}

export function resolveWindowIcon(
  deps: Pick<DesktopLifecycleDeps, "platform" | "assetsDir" | "loadNativeImageFromPath">,
): NativeImageLike | undefined {
  if (deps.platform === "darwin") return undefined;
  const candidates =
    deps.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png"];
  for (const filename of candidates) {
    const fullPath = path.join(deps.assetsDir, filename);
    if (!fs.existsSync(fullPath)) continue;
    const img = deps.loadNativeImageFromPath(fullPath);
    if (img && !img.isEmpty()) return img;
  }
  return undefined;
}

export function createDesktopLifecycle(
  deps: DesktopLifecycleDeps,
): DesktopLifecycleController {
  let hub: HubHandle | undefined;
  let mainWindow: BrowserWindowLike | undefined;
  let tray: TrayLike | undefined;
  let quitting = false;
  let cleanupDone = false;
  let cleanupPromise: Promise<void> | undefined;
  let notifiedTrayMinimize = false;
  let started = false;
  let windowCreationPromise: Promise<void> | undefined;

  const getVersion = (): string => deps.version || deps.app.getVersion?.() || "";
  const getLocale = (): string => deps.app.getLocale?.() || "";
  const getStrings = (): TrayStrings => getTrayStrings(deps.platform, getLocale());

  const hasActiveTray = (): boolean => Boolean(tray && !tray.isDestroyed());

  const isWindowShown = (): boolean =>
    Boolean(
      mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.isVisible() &&
        !mainWindow.isMinimized(),
    );

  const refreshTrayMenu = (): void => {
    if (!hasActiveTray()) return;
    const strings = getStrings();
    const ver = getVersion();
    const items: MenuItemSpec[] = [
      {
        label: ver ? `agent-remote v${ver}` : "agent-remote",
        enabled: false,
      },
    ];
    if (hub?.url) {
      items.push({
        label: `Hub: ${hub.url}`,
        enabled: false,
      });
    }
    items.push({ type: "separator" });

    if (isWindowShown()) {
      items.push({
        label: strings.hideToTray,
        click: () => hideMainWindowToTray(false),
      });
    } else {
      items.push({
        label: strings.showWindow,
        click: () => showMainWindow(),
      });
    }

    if (hub?.url) {
      const targetUrl = hub.url;
      items.push({
        label: strings.openInBrowser,
        click: () => {
          void deps.openExternal(targetUrl);
        },
      });
    }

    items.push({ type: "separator" });
    items.push({
      label: strings.quit,
      click: () => requestQuit(),
    });

    tray!.setContextMenu(deps.buildMenu(items));
  };

  const setupTray = (): void => {
    if (hasActiveTray()) {
      refreshTrayMenu();
      return;
    }
    try {
      const icon = resolveTrayIcon(deps);
      tray = deps.createTray(icon);
      const ver = getVersion();
      tray.setToolTip(ver ? `agent-remote v${ver}` : "agent-remote");
      refreshTrayMenu();

      // On Windows and X11 Linux trays, left-click / double-click brings back
      // the main window while right-click opens the context menu.
      // (On macOS and GNOME AppIndicator / KDE StatusNotifier, both left and
      // right click open the context menu natively.)
      if (deps.platform !== "darwin") {
        tray.on("click", () => showMainWindow());
        tray.on("double-click", () => showMainWindow());
      }
    } catch (err) {
      tray = undefined;
      deps.logger?.warn?.("[agent-remote] Failed to create system tray:", err);
    }
  };

  const ensureMainWindow = async (): Promise<void> => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return;
    }
    if (windowCreationPromise) {
      return windowCreationPromise;
    }

    windowCreationPromise = (async () => {
      if (!hub) {
        hub = await deps.startHub();
      }
      const ver = getVersion();
      const title = ver
        ? `agent-remote v${ver} — Multi-Agent Control Workbench`
        : "agent-remote — Multi-Agent Control Workbench";
      const icon = resolveWindowIcon(deps);
      const win = deps.createBrowserWindow({ title, icon });
      mainWindow = win;

      win.on("close", (rawEvent) => {
        const event = rawEvent as CloseEventLike | undefined;
        if (!quitting && hasActiveTray()) {
          event?.preventDefault();
          hideMainWindowToTray(true);
        }
      });

      win.on("show", () => refreshTrayMenu());
      win.on("hide", () => refreshTrayMenu());
      win.on("minimize", () => refreshTrayMenu());
      win.on("restore", () => refreshTrayMenu());
      win.on("closed", () => {
        if (mainWindow === win) {
          mainWindow = undefined;
        }
        refreshTrayMenu();
      });

      setupTray();
      await win.loadURL(hub.url);
      refreshTrayMenu();
    })().finally(() => {
      windowCreationPromise = undefined;
    });

    return windowCreationPromise;
  };

  const showMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      void ensureMainWindow().then(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          if (deps.platform === "darwin") {
            deps.app.focus?.({ steal: true });
          }
          refreshTrayMenu();
        }
      });
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    if (deps.platform === "darwin") {
      deps.app.focus?.({ steal: true });
    }
    refreshTrayMenu();
  };

  const hideMainWindowToTray = (notifyFirstTime = false): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const doHide = (): void => {
      if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
      mainWindow.hide();
      refreshTrayMenu();
    };

    // On macOS, calling hide() directly on a native fullscreen window leaves
    // an empty black Space; exit fullscreen cleanly first, then hide.
    if (deps.platform === "darwin" && mainWindow.isFullScreen?.()) {
      if (mainWindow.once && mainWindow.setFullScreen) {
        mainWindow.once("leave-full-screen", () => doHide());
        mainWindow.setFullScreen(false);
      } else {
        doHide();
      }
    } else {
      doHide();
    }

    if (notifyFirstTime && !notifiedTrayMinimize) {
      notifiedTrayMinimize = true;
      const strings = getStrings();
      deps.notify?.({
        title: strings.minimizedTitle,
        body: strings.minimizedBody,
      });
    }
  };

  const requestQuit = (): void => {
    quitting = true;
    deps.app.quit();
  };

  const start = (): void => {
    if (started) return;
    started = true;

    if (deps.platform === "win32") {
      deps.app.setAppUserModelId?.(APP_USER_MODEL_ID);
    }

    if (typeof deps.app.requestSingleInstanceLock === "function") {
      const gotLock = deps.app.requestSingleInstanceLock();
      if (!gotLock) {
        quitting = true;
        cleanupDone = true;
        deps.app.quit();
        return;
      }
    }

    deps.app.on("second-instance", () => {
      showMainWindow();
    });

    deps.app.on("activate", () => {
      showMainWindow();
    });

    deps.app.on("window-all-closed", () => {
      // Keep running in the system tray while a tray icon is active.
      // When already quitting, Electron is already tearing down and must not
      // re-enter app.quit() recursively.
      if (!quitting && !hasActiveTray()) {
        deps.app.quit();
      }
    });

    deps.app.on("before-quit", (rawEvent) => {
      const event = rawEvent as CloseEventLike | undefined;
      quitting = true;
      if (cleanupDone) return;

      event?.preventDefault();
      if (!cleanupPromise) {
        cleanupPromise = (async () => {
          try {
            if (tray && !tray.isDestroyed()) {
              tray.destroy();
            }
            tray = undefined;
            if (hub) {
              const currentHub = hub;
              hub = undefined;
              const timeoutMs = deps.shutdownTimeoutMs ?? 4_000;
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  currentHub.close(),
                  new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, timeoutMs);
                  }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
          } catch (err) {
            deps.logger?.warn?.("[agent-remote] Error during shutdown cleanup:", err);
          } finally {
            cleanupDone = true;
            deps.app.quit();
          }
        })();
      }
    });

    void deps.app.whenReady().then(async () => {
      await ensureMainWindow();
      if (hub?.url) {
        const strings = getStrings();
        deps.notify?.({
          title: strings.readyTitle,
          body: strings.readyBody(hub.url),
        });
      }
    });
  };

  return {
    start,
    showMainWindow,
    hideMainWindowToTray,
    requestQuit,
    isQuitting: () => quitting,
    getHubUrl: () => hub?.url,
    getTray: () => tray,
    getMainWindow: () => mainWindow,
  };
}
