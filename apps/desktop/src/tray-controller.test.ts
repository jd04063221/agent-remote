import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  APP_USER_MODEL_ID,
  createDesktopLifecycle,
  getTrayStrings,
  type AppLike,
  type BrowserWindowLike,
  type CloseEventLike,
  type DesktopLifecycleDeps,
  type MenuItemSpec,
  type NativeImageLike,
  type TrayLike,
} from "./tray-controller.js";

const ASSETS_DIR = path.resolve(import.meta.dirname, "../assets");

class MockEmitter {
  private listeners = new Map<string, Array<{ fn: (...args: unknown[]) => void; once: boolean }>>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push({ fn: listener, once: false });
    this.listeners.set(event, arr);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push({ fn: listener, once: true });
    this.listeners.set(event, arr);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const remaining: typeof arr = [];
    for (const entry of arr) {
      entry.fn(...args);
      if (!entry.once) remaining.push(entry);
    }
    this.listeners.set(event, remaining);
  }
}

class FakeWindow extends MockEmitter implements BrowserWindowLike {
  visible = true;
  minimized = false;
  destroyed = false;
  fullScreen = false;
  loadedUrls: string[] = [];
  focusCount = 0;
  showCount = 0;
  hideCount = 0;
  restoreCount = 0;
  title: string;
  icon?: NativeImageLike;

  constructor(opts: { title: string; icon?: NativeImageLike }) {
    super();
    this.title = opts.title;
    this.icon = opts.icon;
  }

  async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
  }

  show(): void {
    this.visible = true;
    this.showCount++;
    this.emit("show");
  }

  hide(): void {
    this.visible = false;
    this.hideCount++;
    this.emit("hide");
  }

  focus(): void {
    this.focusCount++;
  }

  restore(): void {
    this.minimized = false;
    this.restoreCount++;
    this.emit("restore");
  }

  minimize(): void {
    this.minimized = true;
    this.emit("minimize");
  }

  isVisible(): boolean {
    return this.visible;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isFullScreen(): boolean {
    return this.fullScreen;
  }

  setFullScreen(flag: boolean): void {
    this.fullScreen = flag;
    if (!flag) {
      this.emit("leave-full-screen");
    }
  }

  /** Simulates clicking the OS close button (X). */
  simulateUserClose(): { prevented: boolean } {
    let prevented = false;
    const event: CloseEventLike = {
      preventDefault() {
        prevented = true;
      },
    };
    this.emit("close", event);
    if (!prevented) {
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }
    return { prevented };
  }
}

class FakeTray extends MockEmitter implements TrayLike {
  tooltip = "";
  destroyed = false;
  lastMenu: MenuItemSpec[] = [];
  icon: NativeImageLike;

  constructor(icon: NativeImageLike) {
    super();
    this.icon = icon;
  }

  setToolTip(toolTip: string): void {
    this.tooltip = toolTip;
  }

  setContextMenu(menu: unknown): void {
    this.lastMenu = menu as MenuItemSpec[];
  }

  destroy(): void {
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

interface TestHarness {
  app: AppLike & MockEmitter & {
    quitCalls: number;
    exited: boolean;
    focusCalls: number;
    userModelId?: string;
    resolveReady: () => void;
    triggerQuit: () => { prevented: boolean };
  };
  windows: FakeWindow[];
  trays: FakeTray[];
  notifications: Array<{ title: string; body: string }>;
  openedUrls: string[];
  loadedIconPaths: string[];
  templateMarks: boolean[];
  hubStarts: number;
  hubCloses: number;
  hubCloseDeferred?: { resolve: () => void };
  deps: DesktopLifecycleDeps;
}

function createHarness(options: {
  platform: NodeJS.Platform;
  locale?: string;
  singleInstanceLock?: boolean;
  failTrayCreation?: boolean;
  deferHubClose?: boolean;
}): TestHarness {
  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const windows: FakeWindow[] = [];
  const trays: FakeTray[] = [];
  const notifications: Array<{ title: string; body: string }> = [];
  const openedUrls: string[] = [];
  const loadedIconPaths: string[] = [];
  const templateMarks: boolean[] = [];

  const appEmitter = new MockEmitter();
  const appObj = Object.assign(appEmitter, {
    quitCalls: 0,
    exited: false,
    focusCalls: 0,
    userModelId: undefined as string | undefined,
    resolveReady,
    getVersion: () => "0.1.5",
    getLocale: () => options.locale ?? "zh-CN",
    requestSingleInstanceLock: () => options.singleInstanceLock ?? true,
    setAppUserModelId: (id: string) => {
      appObj.userModelId = id;
    },
    whenReady: () => readyPromise,
    focus: () => {
      appObj.focusCalls++;
    },
    triggerQuit(): { prevented: boolean } {
      let prevented = false;
      const event: CloseEventLike = {
        preventDefault() {
          prevented = true;
        },
      };
      appObj.emit("before-quit", event);
      if (!prevented) {
        // Close all surviving windows like Electron does during final quit.
        for (const w of windows) {
          if (!w.destroyed) {
            w.simulateUserClose();
          }
        }
        if (windows.every((w) => w.destroyed)) {
          appObj.emit("window-all-closed");
          appObj.exited = true;
        }
      }
      return { prevented };
    },
    quit(): void {
      appObj.quitCalls++;
      appObj.triggerQuit();
    },
  });

  const harness: TestHarness = {
    app: appObj,
    windows,
    trays,
    notifications,
    openedUrls,
    loadedIconPaths,
    templateMarks,
    hubStarts: 0,
    hubCloses: 0,
    deps: {} as DesktopLifecycleDeps,
  };

  harness.deps = {
    platform: options.platform,
    assetsDir: ASSETS_DIR,
    version: "0.1.5",
    app: appObj,
    async startHub() {
      harness.hubStarts++;
      return {
        url: "http://127.0.0.1:3775",
        async close() {
          harness.hubCloses++;
          if (options.deferHubClose) {
            await new Promise<void>((resolve) => {
              harness.hubCloseDeferred = { resolve };
            });
          }
        },
      };
    },
    createBrowserWindow(opts) {
      const w = new FakeWindow(opts);
      windows.push(w);
      return w;
    },
    createTray(icon) {
      if (options.failTrayCreation) {
        throw new Error("StatusNotifier unavailable");
      }
      const t = new FakeTray(icon);
      trays.push(t);
      return t;
    },
    buildMenu(template) {
      return template;
    },
    loadNativeImageFromPath(filePath) {
      loadedIconPaths.push(filePath);
      return {
        isEmpty: () => false,
        setTemplateImage(flag: boolean) {
          templateMarks.push(flag);
        },
      };
    },
    loadNativeImageFromBuffer() {
      return {
        isEmpty: () => false,
        setTemplateImage(flag: boolean) {
          templateMarks.push(flag);
        },
      };
    },
    openExternal(url) {
      openedUrls.push(url);
    },
    notify(n) {
      notifications.push(n);
    },
    logger: { warn: vi.fn() },
    shutdownTimeoutMs: 500,
  };

  return harness;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

describe("desktop tray & close-to-tray lifecycle", () => {
  it("Windows: closing window hides to system tray; only tray Quit exits cleanly", async () => {
    const h = createHarness({ platform: "win32", locale: "zh-CN", deferHubClose: true });
    const ctrl = createDesktopLifecycle(h.deps);
    ctrl.start();
    h.app.resolveReady();
    await flushMicrotasks();

    expect(h.app.userModelId).toBe(APP_USER_MODEL_ID);
    expect(h.hubStarts).toBe(1);
    expect(h.windows).toHaveLength(1);
    expect(h.trays).toHaveLength(1);
    expect(h.loadedIconPaths.some((p) => p.endsWith("tray-icon.ico"))).toBe(true);
    expect(h.trays[0].tooltip).toBe("agent-remote v0.1.5");

    const win = h.windows[0];
    const tray = h.trays[0];

    // Before closing, tray menu offers "隐藏到系统托盘" and "退出 agent-remote".
    expect(tray.lastMenu.some((i) => i.label === "隐藏到系统托盘")).toBe(true);
    expect(tray.lastMenu.some((i) => i.label === "退出 agent-remote")).toBe(true);

    // 1. Clicking window Close (X) minimizes to tray instead of quitting.
    const closeRes = win.simulateUserClose();
    expect(closeRes.prevented).toBe(true);
    expect(win.isVisible()).toBe(false);
    expect(win.isDestroyed()).toBe(false);
    expect(h.hubCloses).toBe(0);
    expect(h.app.quitCalls).toBe(0);
    expect(tray.lastMenu.some((i) => i.label === "显示主窗口")).toBe(true);
    // First-time minimize shows tray notice (in addition to startup ready notice).
    expect(h.notifications.some((n) => n.title.includes("后台运行"))).toBe(true);

    // 2. Clicking tray icon restores & focuses window; double-click does NOT hide it again.
    tray.emit("click");
    expect(win.isVisible()).toBe(true);
    expect(win.focusCount).toBe(1);
    tray.emit("double-click");
    expect(win.isVisible()).toBe(true);
    expect(win.focusCount).toBe(2);

    // 3. Closing a second time does not spam the tray notification again.
    const noticeCountBefore = h.notifications.length;
    expect(win.simulateUserClose().prevented).toBe(true);
    expect(win.isVisible()).toBe(false);
    expect(h.notifications.length).toBe(noticeCountBefore);

    // 4. Launching a second instance wakes up the existing hidden window.
    h.app.emit("second-instance");
    expect(win.isVisible()).toBe(true);
    expect(h.hubStarts).toBe(1);

    // 5. Clicking "在浏览器中打开 Web UI" in tray menu opens Hub URL.
    const openWebItem = tray.lastMenu.find((i) => i.label === "在浏览器中打开 Web UI");
    expect(openWebItem).toBeDefined();
    openWebItem!.click!();
    expect(h.openedUrls).toEqual(["http://127.0.0.1:3775"]);

    // 6. Right-click -> "退出 agent-remote" awaits hub.close(), destroys tray, then quits.
    const quitItem = tray.lastMenu.find((i) => i.label === "退出 agent-remote");
    expect(quitItem).toBeDefined();
    quitItem!.click!();

    expect(ctrl.isQuitting()).toBe(true);
    expect(tray.isDestroyed()).toBe(true);
    expect(h.hubCloses).toBe(1);
    // Window is still alive until hub.close() resolves and triggers final app.quit().
    expect(win.isDestroyed()).toBe(false);

    h.hubCloseDeferred!.resolve();
    await flushMicrotasks();

    expect(win.isDestroyed()).toBe(true);
    expect(h.app.exited).toBe(true);
    expect(h.app.quitCalls).toBe(2);
  });

  it("macOS: uses Template menu-bar icon, exits fullscreen before hiding, and activate reuses Hub", async () => {
    const h = createHarness({ platform: "darwin", locale: "en-US" });
    const ctrl = createDesktopLifecycle(h.deps);
    ctrl.start();
    h.app.resolveReady();
    await flushMicrotasks();

    expect(h.loadedIconPaths.some((p) => p.endsWith("tray-icon-Template.png"))).toBe(true);
    expect(h.templateMarks).toContain(true);
    expect(h.trays[0].lastMenu.some((i) => i.label === "Hide to Menu Bar")).toBe(true);

    const win = h.windows[0];
    win.fullScreen = true;

    // Closing a fullscreen macOS window leaves fullscreen cleanly and hides to menu bar.
    expect(win.simulateUserClose().prevented).toBe(true);
    expect(win.fullScreen).toBe(false);
    expect(win.isVisible()).toBe(false);
    expect(h.trays[0].lastMenu.some((i) => i.label === "Show Window")).toBe(true);

    // Clicking Dock icon (activate) restores existing window without restarting Hub.
    h.app.emit("activate");
    expect(win.isVisible()).toBe(true);
    expect(h.app.focusCalls).toBe(1);
    expect(h.hubStarts).toBe(1);

    // Quit from status bar menu exits cleanly.
    const quitItem = h.trays[0].lastMenu.find((i) => i.label === "Quit agent-remote");
    quitItem!.click!();
    await flushMicrotasks();
    expect(h.hubCloses).toBe(1);
    expect(win.isDestroyed()).toBe(true);
  });

  it("Linux: closes to tray with Show Window as first action and quits cleanly from tray menu", async () => {
    const h = createHarness({ platform: "linux", locale: "zh-CN" });
    const ctrl = createDesktopLifecycle(h.deps);
    ctrl.start();
    h.app.resolveReady();
    await flushMicrotasks();

    expect(h.loadedIconPaths.some((p) => p.endsWith("tray-icon.png"))).toBe(true);
    const win = h.windows[0];
    const tray = h.trays[0];

    expect(win.simulateUserClose().prevented).toBe(true);
    expect(win.isVisible()).toBe(false);

    // On Linux AppIndicator, left/right click opens the context menu: Show Window must be present.
    const showItem = tray.lastMenu.find((i) => i.label === "显示主窗口");
    expect(showItem).toBeDefined();
    showItem!.click!();
    expect(win.isVisible()).toBe(true);

    const quitItem = tray.lastMenu.find((i) => i.label === "退出 agent-remote");
    quitItem!.click!();
    await flushMicrotasks();
    expect(h.hubCloses).toBe(1);
    expect(win.isDestroyed()).toBe(true);
  });

  it("exits immediately if another GUI instance already holds the single-instance lock", async () => {
    const h = createHarness({ platform: "win32", singleInstanceLock: false });
    const ctrl = createDesktopLifecycle(h.deps);
    ctrl.start();
    h.app.resolveReady();
    await flushMicrotasks();

    expect(h.app.quitCalls).toBe(1);
    expect(h.hubStarts).toBe(0);
    expect(h.windows).toHaveLength(0);
  });

  it("falls back to normal close-to-quit when system tray creation fails", async () => {
    const h = createHarness({ platform: "linux", failTrayCreation: true });
    const ctrl = createDesktopLifecycle(h.deps);
    ctrl.start();
    h.app.resolveReady();
    await flushMicrotasks();

    expect(h.trays).toHaveLength(0);
    const win = h.windows[0];
    const res = win.simulateUserClose();
    expect(res.prevented).toBe(false);
    expect(win.isDestroyed()).toBe(true);

    // Electron fires window-all-closed when the last window closes; without a tray it quits & closes Hub.
    h.app.emit("window-all-closed");
    await flushMicrotasks();
    expect(h.hubCloses).toBe(1);
    expect(h.app.exited).toBe(true);
  });

  it("returns localized strings for zh and en across platforms", () => {
    expect(getTrayStrings("win32", "zh-CN").hideToTray).toBe("隐藏到系统托盘");
    expect(getTrayStrings("darwin", "zh-CN").hideToTray).toBe("隐藏到状态栏");
    expect(getTrayStrings("linux", "en-US").hideToTray).toBe("Hide to Tray");
    expect(getTrayStrings("darwin", "en-US").hideToTray).toBe("Hide to Menu Bar");
  });
});

describe("desktop icon assets integrity", () => {
  it("contains valid PNG, multi-size ICO, ICNS, and macOS Template tray icons", () => {
    const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    for (const file of [
      "icon.png",
      "tray-icon.png",
      "tray-icon-Template.png",
      "tray-icon-Template@2x.png",
    ]) {
      const buf = fs.readFileSync(path.join(ASSETS_DIR, file));
      expect(buf.subarray(0, 8).equals(pngSig), `${file} PNG signature`).toBe(true);
    }

    // Verify 512x512 icon.png dimensions from IHDR
    const appPng = fs.readFileSync(path.join(ASSETS_DIR, "icon.png"));
    expect(appPng.readUInt32BE(16)).toBe(512);
    expect(appPng.readUInt32BE(20)).toBe(512);

    // Verify macOS Template icons are 18x18 and 36x36
    const tpl1 = fs.readFileSync(path.join(ASSETS_DIR, "tray-icon-Template.png"));
    expect(tpl1.readUInt32BE(16)).toBe(18);
    expect(tpl1.readUInt32BE(20)).toBe(18);
    const tpl2 = fs.readFileSync(path.join(ASSETS_DIR, "tray-icon-Template@2x.png"));
    expect(tpl2.readUInt32BE(16)).toBe(36);
    expect(tpl2.readUInt32BE(20)).toBe(36);

    // Verify Windows ICO headers & frame counts
    const appIco = fs.readFileSync(path.join(ASSETS_DIR, "icon.ico"));
    expect(appIco.readUInt16LE(0)).toBe(0);
    expect(appIco.readUInt16LE(2)).toBe(1);
    expect(appIco.readUInt16LE(4)).toBe(5); // 16, 24, 32, 48, 256

    const trayIco = fs.readFileSync(path.join(ASSETS_DIR, "tray-icon.ico"));
    expect(trayIco.readUInt16LE(0)).toBe(0);
    expect(trayIco.readUInt16LE(2)).toBe(1);
    expect(trayIco.readUInt16LE(4)).toBe(4); // 16, 24, 32, 48

    // Verify macOS ICNS header & total length
    const appIcns = fs.readFileSync(path.join(ASSETS_DIR, "icon.icns"));
    expect(appIcns.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(appIcns.readUInt32BE(4)).toBe(appIcns.length);
  });
});
