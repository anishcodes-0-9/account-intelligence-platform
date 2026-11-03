// Protocol-level MCP tests for the stdio transport: a real MCP client connects to the real stdio binary
// (spawned as its own process, via tsx) over a real stdio transport, against a real, migrated Postgres
// database. No service method is called directly.
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CompanyDetailSchema, EnrichContactOutputSchema, ExportContactsOutputSchema, SearchCompaniesOutputSchema, SearchContactsOutputSchema } from "@aip/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { buildMcpFixtures, type McpFixtures } from "./support/mcp-fixtures.js";

const bin = fileURLToPath(new URL("../src/bin/mcp-stdio.ts", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));
const run = { command: process.execPath, args: ["--import", "tsx", bin], cwd };

async function collect(stream: Readable): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += String(chunk);
  return out;
}

let fx: McpFixtures;
beforeAll(async () => {
  fx = await buildMcpFixtures(inject("templateDb"));
});
afterAll(() => fx.close());

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(apiKey: string | undefined, extraEnv: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    ...run,
    env: {
      PATH: process.env.PATH ?? "",
      DATABASE_URL: fx.db.url,
      LOG_LEVEL: "silent",
      ...(apiKey ? { AIP_API_KEY: apiKey } : {}),
      ...extraEnv,
    },
    stderr: "pipe",
  });
  client = new Client({ name: "mcp-test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("MCP stdio: tool discovery and execution (real client, real database)", () => {
  it("discovers exactly the five product tools", async () => {
    const c = await connect(fx.keys.full);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["enrich_contact", "export_contacts", "get_company", "search_companies", "search_contacts"].sort(),
    );
  });

  it("search_companies: returns results matching the public contract", async () => {
    const c = await connect(fx.keys.full);
    const res = await c.callTool({ name: "search_companies", arguments: { limit: 5 } });
    expect(res.isError).toBeFalsy();
    expect(SearchCompaniesOutputSchema.parse(res.structuredContent)).toEqual(res.structuredContent);
    expect((res.structuredContent as { results: unknown[] }).results.length).toBeGreaterThan(0);
  });

  it("get_company: known id succeeds, unknown id returns NOT_FOUND", async () => {
    const c = await connect(fx.keys.full);
    const ok = await c.callTool({ name: "get_company", arguments: { companyId: "cmp_1" } });
    expect(ok.isError).toBeFalsy();
    expect(CompanyDetailSchema.parse(ok.structuredContent)).toMatchObject({ id: "cmp_1" });

    const missing = await c.callTool({ name: "get_company", arguments: { companyId: "cmp_does_not_exist" } });
    expect(missing.isError).toBe(true);
    expect((missing.structuredContent as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("search_contacts: returns public fields only (name/title, not fullName/jobTitle)", async () => {
    const c = await connect(fx.keys.full);
    const res = await c.callTool({ name: "search_contacts", arguments: { companyId: "cmp_1" } });
    expect(res.isError).toBeFalsy();
    expect(SearchContactsOutputSchema.parse(res.structuredContent)).toEqual(res.structuredContent);
  });

  it("enrich_contact: known id returns a structured enrichment result; unknown id is NOT_FOUND", async () => {
    const c = await connect(fx.keys.full);
    const ok = await c.callTool({ name: "enrich_contact", arguments: { contactId: "cnt_1" } });
    expect(ok.isError).toBeFalsy();
    expect(EnrichContactOutputSchema.parse(ok.structuredContent)).toEqual(ok.structuredContent);

    const missing = await c.callTool({ name: "enrich_contact", arguments: { contactId: "cnt_does_not_exist" } });
    expect(missing.isError).toBe(true);
    expect((missing.structuredContent as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("export_contacts: returns a usable, time-limited download URL", async () => {
    const c = await connect(fx.keys.full);
    const res = await c.callTool({ name: "export_contacts", arguments: { contactIds: ["cnt_1", "cnt_2"] } });
    expect(res.isError).toBeFalsy();
    const out = ExportContactsOutputSchema.parse(res.structuredContent);
    expect(out.downloadUrl).toMatch(/^https?:\/\/.+\/downloads\/[A-Za-z0-9_-]{43}$/);
    expect(out.rowCount).toBe(2);
  });

  it("rejects invalid tool arguments without running the handler", async () => {
    const c = await connect(fx.keys.full);
    const res = await c.callTool({ name: "get_company", arguments: {} });
    expect(res.isError).toBe(true);
  });

  it("documents the one real difference in error shape: SDK-level shape rejection vs. our own mapError rejection", async () => {
    const c = await connect(fx.keys.full);

    // A raw shape violation (missing a required field) never reaches our handler at all -- the SDK's own
    // schema check rejects it first and returns isError:true with no structuredContent. See
    // docs/mcp-server.md ("Validation error shapes") for why this is accepted as-is rather than papered
    // over: there is no supported SDK option to keep schema-based discovery/validation while customizing
    // the shape of its own rejection.
    const shapeRejected = await c.callTool({ name: "get_company", arguments: {} });
    expect(shapeRejected.isError).toBe(true);
    expect(shapeRejected.structuredContent).toBeUndefined();
    expect(JSON.stringify(shapeRejected.content)).toMatch(/validation/i);

    // A business-rule violation that passes the raw shape (both fields present, but neither usable) is
    // rejected by our own ContactService -> mapError -> fail(), which always carries structuredContent.
    const serviceRejected = await c.callTool({ name: "search_contacts", arguments: {} });
    expect(serviceRejected.isError).toBe(true);
    expect((serviceRejected.structuredContent as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("MCP stdio: authentication and authorization", () => {
  it("refuses to start with missing, invalid, expired or revoked credentials", async () => {
    for (const apiKey of [undefined, "not-a-real-key", fx.keys.expired, fx.keys.revoked]) {
      const child = spawn(run.command, run.args, {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          DATABASE_URL: fx.db.url,
          LOG_LEVEL: "silent",
          ...(apiKey ? { AIP_API_KEY: apiKey } : {}),
        },
      });
      const [stdout, stderr, code] = await Promise.all([
        collect(child.stdout),
        collect(child.stderr),
        new Promise<number | null>((resolve) => child.on("close", resolve)),
      ]);
      expect(code, `apiKey=${String(apiKey)}`).toBe(1);
      expect(stdout).toBe(""); // stdout stays protocol-only, even on failure
      expect(stderr).toContain("refusing to start");
      if (apiKey) expect(stderr).not.toContain(apiKey);
    }
  });

  it("rejects a tool call when the authenticated key lacks the required scope", async () => {
    const c = await connect(fx.keys.companiesOnly);
    const res = await c.callTool({ name: "enrich_contact", arguments: { contactId: "cnt_1" } });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: { code: string; message: string } }).error).toMatchObject({ code: "FORBIDDEN" });
  });

  it("a companies-only key is rejected for every tool outside its scope", async () => {
    const c = await connect(fx.keys.companiesOnly);
    for (const call of [
      { name: "search_contacts", arguments: { companyId: "cmp_1" } },
      { name: "enrich_contact", arguments: { contactId: "cnt_1" } },
      { name: "export_contacts", arguments: { contactIds: ["cnt_1"] } },
    ]) {
      const res = await c.callTool(call);
      expect(res.isError, call.name).toBe(true);
      expect((res.structuredContent as { error: { code: string } }).error.code, call.name).toBe("FORBIDDEN");
    }
    // ...but still works for the scope it does have.
    const allowed = await c.callTool({ name: "search_companies", arguments: {} });
    expect(allowed.isError).toBeFalsy();
  });

  it("never writes the API key or a download URL/token to stderr diagnostics", async () => {
    const transport = new StdioClientTransport({
      ...run,
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: fx.db.url, AIP_API_KEY: fx.keys.full },
      stderr: "pipe",
    });
    const stderrChunks: string[] = [];
    transport.stderr?.on("data", (c: Buffer) => stderrChunks.push(c.toString()));
    const c = new Client({ name: "mcp-test-client", version: "0.0.0" });
    await c.connect(transport);
    const res = await c.callTool({ name: "export_contacts", arguments: { contactIds: ["cnt_1"] } });
    const downloadUrl = (res.structuredContent as { downloadUrl: string }).downloadUrl;
    await c.close();

    const stderrText = stderrChunks.join("");
    expect(stderrText).not.toContain(fx.keys.full);
    expect(stderrText).not.toContain(downloadUrl);
  });
});

describe("MCP stdio: stdout/stderr hygiene on the success path", () => {
  // The SDK's own StdioClientTransport does not expose the child process's raw stdout for inspection
  // (only `.stderr`, per its type declaration) -- by design, since stdout is the thing it is itself
  // consuming as the protocol channel. To literally see the bytes on a successful exchange, this test
  // spawns the real binary directly (as the "fails closed" test above already does) and writes the
  // minimal, spec-correct JSON-RPC frames by hand: initialize, the `initialized` notification, then one
  // real tools/call. This is not a reimplementation of MCP business logic -- every one of the five tools'
  // actual handling (parsing, auth, scope checks, service calls) still runs for real inside the spawned
  // process; only the client-side framing is written by hand because the official Client class gives no
  // way to tee its own transport's stdout. Full protocol-level success-path coverage through the real,
  // official `Client` class is in the describe block above and in mcp-http.test.ts; this test exists
  // purely to inspect raw bytes on the wire.
  it("stdout contains only newline-delimited JSON-RPC frames; diagnostics go to stderr only", async () => {
    const child = spawn(run.command, run.args, {
      cwd,
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: fx.db.url, AIP_API_KEY: fx.keys.full, LOG_LEVEL: "info" },
    });

    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-stdout-check", version: "0" } },
    });
    const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const callTool = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_companies", arguments: { limit: 1 } },
    });

    child.stdin.write(`${initialize}\n`);
    child.stdin.write(`${initialized}\n`);
    child.stdin.write(`${callTool}\n`);

    // Wait for both JSON-RPC responses (ids 1 and 2) to arrive, then stop.
    let stdoutBuf = "";
    const gotBothResponses = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const ids = stdoutBuf
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return (JSON.parse(line) as { id?: number }).id;
            } catch {
              return undefined;
            }
          });
        if (ids.includes(1) && ids.includes(2)) resolve();
      });
    });
    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => (stderrBuf += chunk.toString()));

    await Promise.race([gotBothResponses, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("close", resolve));

    const lines = stdoutBuf.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const parsed = lines.map((line) => JSON.parse(line) as { jsonrpc?: string; id?: number }); // throws if any line is not valid JSON
    expect(parsed.every((p) => p.jsonrpc === "2.0")).toBe(true);
    const callToolResponse = parsed.find((p) => p.id === 2) as { result?: { structuredContent?: { results: unknown[] } } } | undefined;
    expect(callToolResponse?.result?.structuredContent?.results).toBeDefined();

    // The server's own "ready" diagnostic went to stderr, not stdout, and stdout carries no log lines.
    expect(stderrBuf).toContain("aip mcp stdio server ready");
    expect(stdoutBuf).not.toContain("aip mcp stdio server ready");
    expect(stdoutBuf).not.toContain(fx.keys.full);
  }, 15_000);
});
