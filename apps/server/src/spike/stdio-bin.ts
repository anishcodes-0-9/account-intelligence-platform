// TEMPORARY (M1 spike). stdout is reserved for protocol messages; diagnostics go to stderr.
import { timingSafeEqual } from "node:crypto";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createSpikeServer } from "./spike-server.js";

const expected = process.env.SPIKE_API_KEY;
const supplied = process.env.AIP_API_KEY;
const a = Buffer.from(supplied ?? "");
const b = Buffer.from(expected ?? "");
if (!expected || !supplied || a.length !== b.length || !timingSafeEqual(a, b)) {
  process.stderr.write("AIP_API_KEY missing or invalid; refusing to start\n");
  process.exit(1);
}

const handle = serveStdio(() => createSpikeServer(), {
  onerror: (e) => process.stderr.write(`mcp error: ${e.message}\n`),
});
const stop = (): void => void handle.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stderr.write("spike stdio server ready\n");
