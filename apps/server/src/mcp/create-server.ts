import { McpServer } from "@modelcontextprotocol/server";
import type { Logger } from "@aip/core";
import { registerTools, type PrincipalResolver } from "./register-tools.js";
import type { McpServices } from "./services.js";

export const AIP_MCP_SERVER_NAME = "aip";
export const AIP_MCP_SERVER_VERSION = "0.0.0";

/** One shared factory for both transports: identical tool definitions, schemas and business logic. */
export function createAipMcpServer(services: McpServices, resolvePrincipal: PrincipalResolver, logger: Logger): McpServer {
  const server = new McpServer({ name: AIP_MCP_SERVER_NAME, version: AIP_MCP_SERVER_VERSION });
  registerTools(server, services, resolvePrincipal, logger);
  return server;
}
