import { buildSpikeHttpApp } from "./http-app.js";

const apiKey = process.env.SPIKE_API_KEY;
if (!apiKey) {
  process.stderr.write("SPIKE_API_KEY is required\n");
  process.exit(1);
}
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3001);
const { app, close } = buildSpikeHttpApp({ host, apiKey });

const shutdown = async (signal: string): Promise<void> => {
  process.stderr.write(`${signal} received, shutting down\n`);
  await close();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host, port });
process.stderr.write(`spike http listening on http://${host}:${port}/mcp\n`);
