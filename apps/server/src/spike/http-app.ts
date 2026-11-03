// TEMPORARY (M1 spike): Fastify + MCP Streamable HTTP wiring with bearer API-key auth.
import { timingSafeEqual } from "node:crypto";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import { createSpikeServer } from "./spike-server.js";

function keyMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SpikeHttpOptions {
  host: string;
  apiKey: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

export function buildSpikeHttpApp(opts: SpikeHttpOptions): { app: FastifyInstance; close: () => Promise<void> } {
  const app = createMcpFastifyApp({
    host: opts.host,
    ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
  });
  const handler = createMcpHandler(() => createSpikeServer());
  const node = toNodeHandler(handler);

  app.all("/mcp", async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token || !keyMatches(token, opts.apiKey)) {
      return reply
        .code(401)
        .header("WWW-Authenticate", 'Bearer realm="aip", error="invalid_token"')
        .send({ error: { code: "UNAUTHENTICATED", message: "Missing or invalid API key" } });
    }
    const auth: AuthInfo = { token: "[redacted]", clientId: "spike-key", scopes: ["spike"] };
    (request.raw as IncomingMessage & { auth?: AuthInfo }).auth = auth;
    reply.hijack();
    // SDK limitation (v2.1.2 @modelcontextprotocol/node): NodeIncomingMessageLike declares `method?: string`,
    // which node:http's IncomingMessage (`string | undefined`) fails under exactOptionalPropertyTypes.
    // The cast is confined to this boundary rather than weakening the repo-wide compiler flag.
    await node(request.raw as unknown as Parameters<typeof node>[0], reply.raw, request.body);
  });

  return { app, close: () => handler.close() };
}
