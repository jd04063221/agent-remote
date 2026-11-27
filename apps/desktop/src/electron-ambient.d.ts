declare module "electron" {
  export interface Event {
    preventDefault(): void;
  }

  export interface NativeImage {
    isEmpty(): boolean;
    setTemplateImage(option: boolean): void;
    resize(options: { width?: number; height?: number; quality?: string }): NativeImage;
  }

  export const nativeImage: {
    createFromPath(imagePath: string): NativeImage;
    createFromDataURL(dataURL: string): NativeImage;
    createFromBuffer(buffer: Buffer): NativeImage;
    createEmpty(): NativeImage;
  };

  export interface MenuItemConstructorOptions {
    label?: string;
    type?: "normal" | "separator" | "submenu" | "checkbox" | "radio";
    enabled?: boolean;
    click?: () => void;
    accelerator?: string;
    role?: string;
  }

  export interface Menu {}

  export const Menu: {
    buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
  };

  export class Tray {
    constructor(image: NativeImage | string);
    setToolTip(toolTip: string): void;
    setContextMenu(menu: Menu | null): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
    popUpContextMenu(menu?: Menu): void;
    destroy(): void;
    isDestroyed(): boolean;
  }

  export interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    title?: string;
    icon?: NativeImage | string;
    backgroundColor?: string;
    webPreferences?: {
      preload?: string;
      contextIsolation?: boolean;
      nodeIntegration?: boolean;
      sandbox?: boolean;
    };
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowConstructorOptions);
    loadURL(url: string): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    show(): void;
    hide(): void;
    focus(): void;
    restore(): void;
    close(): void;
    destroy(): void;
    isVisible(): boolean;
    isMinimized(): boolean;
    isDestroyed(): boolean;
    isFullScreen(): boolean;
    setFullScreen(flag: boolean): void;
    static getAllWindows(): BrowserWindow[];
  }

  export class Notification {
    constructor(options: { title: string; body: string; silent?: boolean });
    show(): void;
    static isSupported(): boolean;
  }

  export const shell: {
    openExternal(url: string): Promise<void>;
  };

  export const app: {
    readonly isPackaged?: boolean;
    getVersion(): string;
    getLocale(): string;
    requestSingleInstanceLock(): boolean;
    setAppUserModelId(id: string): void;
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    focus(options?: { steal?: boolean }): void;
    quit(): void;
    exit(exitCode?: number): void;
  };

  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: Record<string, unknown>): void;
  };
}
