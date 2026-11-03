import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { SPIKE_KEY, collect } from "./spike-helpers.js";

const bin = fileURLToPath(new URL("../src/spike/stdio-bin.ts", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));
const run = { command: process.execPath, args: ["--import", "tsx", bin], cwd };

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    ...run,
    env: { PATH: process.env.PATH ?? "", SPIKE_API_KEY: SPIKE_KEY, AIP_API_KEY: SPIKE_KEY },
    stderr: "pipe",
  });
  client = new Client({ name: "spike-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("spike over stdio (real MCP client)", () => {
  it("discovers tools and calls ping with structured output", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const ping = tools.find((t) => t.name === "ping");
    expect(ping?.inputSchema).toMatchObject({ type: "object", required: ["message"] });
    expect(ping?.outputSchema).toMatchObject({ type: "object" });
    const res = await c.callTool({ name: "ping", arguments: { message: "hello" } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ pong: "hello", caller: null });
    expect(res.content).toEqual([{ type: "text", text: JSON.stringify({ pong: "hello", caller: null }) }]);
  });

  it("reports input-validation failures as isError without running the handler", async () => {
    const c = await connect();
    const res = await c.callTool({ name: "ping", arguments: { message: "" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/validation/i);
  });

  it("surfaces returned isError results intact", async () => {
    const c = await connect();
    const res = await c.callTool({ name: "spike_returns_error", arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toEqual({ error: { code: "NOT_FOUND", message: "nothing here" } });
  });

  it("records how thrown errors and bad structuredContent are surfaced", async () => {
    const c = await connect();
    const thrown = await c.callTool({ name: "spike_throws", arguments: {} }).then(
      (r) => ({ kind: "result" as const, r }),
      (e: unknown) => ({ kind: "rejected" as const, e }),
    );
    console.log("THROWN ->", JSON.stringify(thrown, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v)));
    const bad = await c.callTool({ name: "spike_bad_output", arguments: {} }).then(
      (r) => ({ kind: "result" as const, r }),
      (e: unknown) => ({ kind: "rejected" as const, e }),
    );
    console.log("BAD_OUTPUT ->", JSON.stringify(bad, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v)));
    expect(thrown).toBeDefined();
  });

  it("fails closed: refuses to start without a valid key and writes nothing to stdout", async () => {
    for (const env of [{}, { AIP_API_KEY: "wrong", SPIKE_API_KEY: SPIKE_KEY }]) {
      const child = spawn(run.command, run.args, { cwd, env: { PATH: process.env.PATH ?? "", SPIKE_API_KEY: SPIKE_KEY, ...env } });
      const [stdout, stderr, code] = await Promise.all([
        collect(child.stdout),
        collect(child.stderr),
        new Promise<number | null>((resolve) => child.on("close", resolve)),
      ]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("refusing to start");
      expect(stderr).not.toContain(SPIKE_KEY);
    }
  });

  it("shuts down cleanly when the client closes", async () => {
    const transport = new StdioClientTransport({
      ...run,
      env: { PATH: process.env.PATH ?? "", SPIKE_API_KEY: SPIKE_KEY, AIP_API_KEY: SPIKE_KEY },
      stderr: "pipe",
    });
    const c = new Client({ name: "spike-client", version: "0.0.0" });
    await c.connect(transport);
    const closed = new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });
    await c.close();
    await closed;
  });
});
