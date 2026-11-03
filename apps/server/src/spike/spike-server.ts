// TEMPORARY (M1 spike): removed in M5. Not part of the five-tool product interface.
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

export function createSpikeServer(): McpServer {
  const server = new McpServer({ name: "aip-spike", version: "0.0.0" });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Spike tool: echoes a message and reports the authenticated caller.",
      inputSchema: z.object({ message: z.string().min(1).max(100) }),
      outputSchema: z.object({ pong: z.string(), caller: z.string().nullable() }),
      annotations: { readOnlyHint: true },
    },
    ({ message }, ctx) => {
      const output = { pong: message, caller: ctx.http?.authInfo?.clientId ?? null };
      return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
    },
  );

  // Error-semantics probes.
  server.registerTool(
    "spike_returns_error",
    { description: "Spike: returns an isError result.", inputSchema: z.object({}) },
    () => ({
      isError: true,
      content: [{ type: "text", text: "NOT_FOUND: nothing here" }],
      structuredContent: { error: { code: "NOT_FOUND", message: "nothing here" } },
    }),
  );
  server.registerTool(
    "spike_throws",
    { description: "Spike: throws an Error.", inputSchema: z.object({}) },
    () => {
      throw new Error("boom: secret-internal-detail");
    },
  );
  server.registerTool(
    "spike_bad_output",
    {
      description: "Spike: returns structuredContent violating outputSchema.",
      inputSchema: z.object({}),
      outputSchema: z.object({ n: z.number() }),
    },
    () => ({ content: [{ type: "text", text: "x" }], structuredContent: { n: "not-a-number" } as never }),
  );

  return server;
}
