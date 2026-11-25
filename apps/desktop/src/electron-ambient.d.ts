declare module "electron" {
  export interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    title?: string;
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
    static getAllWindows(): BrowserWindow[];
  }

  export class Notification {
    constructor(options: { title: string; body: string });
    show(): void;
    static isSupported(): boolean;
  }

  export const app: {
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    quit(): void;
  };

  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: Record<string, unknown>): void;
  };
}
