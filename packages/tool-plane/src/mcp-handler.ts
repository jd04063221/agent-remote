import type { McpRpcReqPayload, McpRpcResPayload } from "@agent-remote/protocol";
import type { LocalToolEngine, ToolExecutionContext } from "./tools.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Handles Streamable-HTTP MCP JSON-RPC requests tunneled from remote-node over WSS (MCP-over-WSS).
 */
export class McpJsonRpcHandler {
  private readonly engine: LocalToolEngine;
  private readonly serverName: string;

  constructor(engine: LocalToolEngine, serverName = "agent-remote-local-tools") {
    this.engine = engine;
    this.serverName = serverName;
  }

  async handleRpc(
    req: McpRpcReqPayload,
    ctx: ToolExecutionContext,
  ): Promise<McpRpcResPayload> {
    const httpMethod = (req.method ?? "POST").toUpperCase();
    if (httpMethod === "GET") {
      // MCP Streamable-HTTP 2025-03-26: return 405 when optional standalone SSE stream is not offered
      return {
        rpcId: req.rpcId,
        status: 405,
        headers: { Allow: "POST, DELETE" },
        body: "",
      };
    }
    if (httpMethod === "DELETE") {
      return {
        rpcId: req.rpcId,
        status: 204,
        headers: {},
        body: "",
      };
    }

    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(req.body) as JsonRpcRequest;
    } catch {
      return jsonRes(req.rpcId, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }

    const id = parsed.id ?? null;

    // JSON-RPC notifications have no id and expect 202 Accepted with empty body per MCP Streamable-HTTP
    if (parsed.id === undefined && typeof parsed.method === "string" && parsed.method.startsWith("notifications/")) {
      return {
        rpcId: req.rpcId,
        status: 202,
        headers: {},
        body: "",
      };
    }

    switch (parsed.method) {
      case "initialize":
        return jsonRes(req.rpcId, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: this.serverName, version: "0.1.0" },
          },
        });

      case "notifications/initialized":
        return {
          rpcId: req.rpcId,
          status: 202,
          headers: {},
          body: "",
        };

      case "ping":
        return jsonRes(req.rpcId, 200, { jsonrpc: "2.0", id, result: {} });

      case "tools/list":
        return jsonRes(req.rpcId, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            tools: this.engine.listToolDefinitions(),
          },
        });

      case "tools/call": {
        const name = String(parsed.params?.name ?? "");
        const toolArgs = (parsed.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const outcome = await this.engine.executeTool(name, toolArgs, ctx);
          return jsonRes(req.rpcId, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: outcome.content }],
              isError: !outcome.ok,
            },
          });
        } catch (err) {
          return jsonRes(req.rpcId, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `Tool error: ${(err as Error).message}` }],
              isError: true,
            },
          });
        }
      }

      default:
        return jsonRes(req.rpcId, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${parsed.method}` },
        });
    }
  }
}

function jsonRes(rpcId: string, status: number, payload: unknown): McpRpcResPayload {
  return {
    rpcId,
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}
