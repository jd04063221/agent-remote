import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeTailnetEndpoint, TailnetDirectClient } from "./tailnet-client.js";

describe("normalizeTailnetEndpoint", () => {
  it("normalizes https, http, bare hostnames, and /healthz URLs into /v1/ws", () => {
    expect(normalizeTailnetEndpoint("https://racknerd-3e0817b.tailcf3e1.ts.net")).toBe(
      "wss://racknerd-3e0817b.tailcf3e1.ts.net/v1/ws",
    );
    expect(normalizeTailnetEndpoint("https://racknerd-3e0817b.tailcf3e1.ts.net/")).toBe(
      "wss://racknerd-3e0817b.tailcf3e1.ts.net/v1/ws",
    );
    expect(normalizeTailnetEndpoint("https://racknerd-3e0817b.tailcf3e1.ts.net/healthz")).toBe(
      "wss://racknerd-3e0817b.tailcf3e1.ts.net/v1/ws",
    );
    expect(normalizeTailnetEndpoint("wss://racknerd-3e0817b.tailcf3e1.ts.net")).toBe(
      "wss://racknerd-3e0817b.tailcf3e1.ts.net/v1/ws",
    );
    expect(normalizeTailnetEndpoint("wss://racknerd-3e0817b.tailcf3e1.ts.net/v1/ws")).toBe(
      "wss://racknerd-3e0817b.tailcf3e1.ts.net/v1/ws",
    );
    expect(normalizeTailnetEndpoint("racknerd-3e0817b.tailcf3e1.ts.net")).toBe(
      "wss://racknerd-3e0817b.tailcf3e1.ts.net/v1/ws",
    );
    expect(normalizeTailnetEndpoint("http://127.0.0.1:19420")).toBe(
      "ws://127.0.0.1:19420/v1/ws",
    );
    expect(normalizeTailnetEndpoint("127.0.0.1:19420")).toBe(
      "ws://127.0.0.1:19420/v1/ws",
    );
    expect(normalizeTailnetEndpoint("wss://box.ts.net/custom/ws")).toBe(
      "wss://box.ts.net/custom/ws",
    );
    expect(normalizeTailnetEndpoint("   ")).toBe("");
  });
});

describe("TailnetDirectClient error reporting", () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized: missing Tailscale-User-Login header");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("surfaces HTTP status and response body when WebSocket upgrade is rejected", async () => {
    const client = new TailnetDirectClient({
      hostId: "test-401",
      endpoint: `http://127.0.0.1:${port}`,
      autoReconnect: false,
    });
    expect(client.endpoint).toBe(`ws://127.0.0.1:${port}/v1/ws`);
    await expect(client.connect(3000)).rejects.toThrow(
      /HTTP 401.*missing Tailscale-User-Login header/,
    );
    client.close();
  });
});
