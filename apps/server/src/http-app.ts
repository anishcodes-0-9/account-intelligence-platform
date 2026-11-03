// The one HTTP server: MCP Streamable HTTP (/mcp, unchanged from M5) plus the M6 REST API and CSV
// download route, all on the same Fastify instance and the same host/port -- so the URL
// export_contacts/POST /api/contacts/export return actually resolves against this server.
import type { Logger } from "@aip/core";
import { registerDownloadRoute } from "./rest/downloads.js";
import { registerRestRoutes } from "./rest/routes.js";
import { buildMcpHttpApp, type BuiltMcpHttpApp, type McpHttpOptions } from "./mcp/http-app.js";
import type { McpServices } from "./mcp/services.js";

export type { McpHttpOptions } from "./mcp/http-app.js";
export type BuiltHttpApp = BuiltMcpHttpApp;

export function buildHttpApp(services: McpServices, logger: Logger, opts: McpHttpOptions): BuiltHttpApp {
  const mcp = buildMcpHttpApp(services, services.apiKeys, logger, opts);
  registerRestRoutes(mcp.app, services, logger);
  registerDownloadRoute(mcp.app, services.exports, logger);
  return mcp;
}
