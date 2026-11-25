import crypto from "node:crypto";
import http from "node:http";
import type { McpJsonRpcHandler } from "./mcp-handler.js";
import type { ToolExecutionContext } from "./tools.js";

/**
 * Ephemeral local loopback HTTP MCP server used for zero-install SSH (`-R`) reverse tunnels
 * and local direct-process sessions, protected by a per-session 256-bit Bearer token.
 */
export class LocalHttpMcpServer {
  readonly bearerToken: string;
  private readonly handler: McpJsonRpcHandler;
  private readonly ctxFactory: () => ToolExecutionContext;
  private server?: http.Server;
  private port = 0;

  constructor(handler: McpJsonRpcHandler, ctxFactory: () => ToolExecutionContext) {
    this.handler = handler;
    this.ctxFactory = ctxFactory;
    this.bearerToken = crypto.randomBytes(32).toString("hex");
  }

  async start(bindHost = "127.0.0.1"): Promise<{ port: number; url: string; token: string }> {
    this.server = http.createServer((req, res) => {
      void this.onRequest(req, res);
    });
    // Node.js defaults `requestTimeout` to 300s; disable it so long-running scripts and
    // delegated subagents over local/SSH HTTP MCP never get forcibly disconnected at 5 minutes.
    this.server.requestTimeout = 0;
    this.server.timeout = 0;
    await new Promise<void>((resolve) => {
      this.server!.listen(0, bindHost, () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return {
      port: this.port,
      url: `http://${bindHost}:${this.port}/mcp`,
      token: this.bearerToken,
    };
  }

  getPort(): number {
    return this.port;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${this.bearerToken}`;
    const aBuf = Buffer.from(auth);
    const bBuf = Buffer.from(expected);
    if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }

    let body = "";
    for await (const chunk of req) {
      body += (chunk as Buffer).toString("utf8");
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === "authorization") continue;
      if (typeof v === "string") headers[k] = v;
    }

    const ctx = this.ctxFactory();
    const out = await this.handler.handleRpc(
      {
        rpcId: crypto.randomUUID(),
        sessionId: ctx.sessionId,
        method: req.method ?? "POST",
        path: req.url ?? "/mcp",
        headers,
        body,
      },
      ctx,
    );

    res.writeHead(out.status || 200, out.headers);
    res.end(out.body);
  }
}
