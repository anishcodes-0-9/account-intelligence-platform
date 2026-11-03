// MCP stdio entry point. stdout is protocol-only; every diagnostic goes to stderr (CLAUDE.md).
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createLogger, stderrDestination, type AuthPrincipal } from "@aip/core";
import { downloadBaseUrl, loadConfig } from "../config.js";
import { createAipMcpServer } from "../mcp/create-server.js";
import { buildServices } from "../mcp/services.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}

const logger = createLogger({ destination: stderrDestination(), name: "aip-mcp-stdio" });

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, services } = buildServices({
    databaseUrl: config.DATABASE_URL,
    downloadBaseUrl: downloadBaseUrl(config),
    logger,
  });

  let principal: AuthPrincipal;
  try {
    principal = await services.apiKeys.verify(process.env.AIP_API_KEY);
  } catch (error) {
    logger.error({ err: error }, "AIP_API_KEY missing or invalid; refusing to start");
    await db.$disconnect();
    process.exit(1);
  }

  const handle = serveStdio(() => createAipMcpServer(services, () => principal, logger), {
    onerror: (e) => logger.error({ err: e }, "mcp stdio transport error"),
  });
  const stop = (): void => {
    void handle.close().then(() => db.$disconnect()).then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  logger.info({ keyId: principal.keyId }, "aip mcp stdio server ready");
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "fatal startup error");
  process.exit(1);
});
