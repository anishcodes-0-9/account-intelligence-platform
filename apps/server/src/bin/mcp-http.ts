// MCP Streamable HTTP entry point, served at /mcp.
import { createLogger } from "@aip/core";
import { downloadBaseUrl, loadConfig } from "../config.js";
import { buildMcpHttpApp } from "../mcp/http-app.js";
import { buildServices } from "../mcp/services.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, name: "aip-mcp-http" });
  const { db, services } = buildServices({
    databaseUrl: config.DATABASE_URL,
    downloadBaseUrl: downloadBaseUrl(config),
    logger,
  });
  const { app, close } = buildMcpHttpApp(services, services.apiKeys, logger, { host: config.HOST });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await close();
    await app.close();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info({ host: config.HOST, port: config.PORT }, "mcp http listening on /mcp");
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal startup error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
