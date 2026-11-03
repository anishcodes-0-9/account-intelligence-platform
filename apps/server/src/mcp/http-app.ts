// Streamable HTTP transport: Fastify + the MCP SDK's HTTP adapter, Bearer API-key auth enforced before
// any tool runs. Follows the exact pattern verified in the M1 spike (docs/decisions/0001).
import type { IncomingMessage } from "node:http";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import type { FastifyInstance } from "fastify";
import { mapError, type ApiKeyService, type Logger } from "@aip/core";
import { createAipMcpServer } from "./create-server.js";
import { authInfoFor, principalFromAuthInfo } from "./register-tools.js";
import type { McpServices } from "./services.js";

export interface McpHttpOptions {
  host: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

export interface BuiltMcpHttpApp {
  app: FastifyInstance;
  close: () => Promise<void>;
}

/**
 * Every request gets a fresh `McpServer` instance (stateless, as the SDK spike found), but the tool
 * handlers inside it resolve the principal from `ctx.http.authInfo` -- the `AuthInfo` this route
 * verifies and attaches below, never from anything the client's JSON-RPC payload supplied.
 */
export function buildMcpHttpApp(services: McpServices, apiKeys: ApiKeyService, logger: Logger, opts: McpHttpOptions): BuiltMcpHttpApp {
  const app = createMcpFastifyApp({
    host: opts.host,
    ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
  });
  const handler = createMcpHandler(() =>
    createAipMcpServer(services, (ctx) => principalFromAuthInfo(ctx.http?.authInfo), logger),
  );
  const node = toNodeHandler(handler);

  app.all("/mcp", async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    try {
      const principal = await apiKeys.verify(token);
      (request.raw as IncomingMessage & { auth?: AuthInfo }).auth = authInfoFor(principal);
    } catch (error) {
      const { httpStatus, body } = mapError(error, logger, { route: "/mcp" });
      return reply
        .code(httpStatus)
        .header("WWW-Authenticate", 'Bearer realm="aip", error="invalid_token"')
        .send(body);
    }
    reply.hijack();
    // SDK limitation (v2.1.2 @modelcontextprotocol/node), confined to this boundary (docs/decisions/0001).
    await node(request.raw as unknown as Parameters<typeof node>[0], reply.raw, request.body);
  });

  return { app, close: () => handler.close() };
}
