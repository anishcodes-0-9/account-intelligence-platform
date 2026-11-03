// Confirms both transports return equivalent public tool contracts for equivalent inputs: the same
// shared tool definitions and service instances back both, so this is a regression guard against the
// two entry points drifting apart, not a retest of either transport's own mechanics.
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createLogger } from "@aip/core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildMcpHttpApp } from "../src/mcp/http-app.js";
import { buildServices, type BuiltServices } from "../src/mcp/services.js";
import { buildMcpFixtures, type McpFixtures } from "./support/mcp-fixtures.js";

const bin = fileURLToPath(new URL("../src/bin/mcp-stdio.ts", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));

let fx: McpFixtures;
let built: BuiltServices;
let app: Awaited<ReturnType<typeof buildMcpHttpApp>>;
let httpUrl = "";
let stdioClient: Client;
let httpClient: Client;

beforeAll(async () => {
  fx = await buildMcpFixtures(inject("templateDb"));

  built = buildServices({ databaseUrl: fx.db.url, downloadBaseUrl: "http://127.0.0.1:0", logger: createLogger({ level: "silent" }) });
  app = buildMcpHttpApp(built.services, built.services.apiKeys, createLogger({ level: "silent" }), { host: "127.0.0.1" });
  await app.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.app.server.address() as AddressInfo).port;
  httpUrl = `http://127.0.0.1:${port}/mcp`;

  httpClient = new Client({ name: "parity-http", version: "0.0.0" });
  await httpClient.connect(new StreamableHTTPClientTransport(new URL(httpUrl), { requestInit: { headers: { Authorization: `Bearer ${fx.keys.full}` } } }));

  stdioClient = new Client({ name: "parity-stdio", version: "0.0.0" });
  await stdioClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", bin],
      cwd,
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: fx.db.url, AIP_API_KEY: fx.keys.full, LOG_LEVEL: "silent" },
      stderr: "pipe",
    }),
  );
});

afterAll(async () => {
  await stdioClient.close();
  await httpClient.close();
  await app.close();
  await app.app.close();
  await built.db.$disconnect();
  await fx.close();
});

describe("stdio and Streamable HTTP agree on tool contracts", () => {
  it("list exactly the same five tools with the same input/output schemas", async () => {
    const [stdio, http] = await Promise.all([stdioClient.listTools(), httpClient.listTools()]);
    const byName = (list: typeof stdio.tools) => Object.fromEntries(list.map((t) => [t.name, t]));
    const stdioByName = byName(stdio.tools);
    const httpByName = byName(http.tools);
    expect(Object.keys(stdioByName).sort()).toEqual(Object.keys(httpByName).sort());
    for (const name of Object.keys(stdioByName)) {
      expect(httpByName[name]?.inputSchema, name).toEqual(stdioByName[name]?.inputSchema);
      expect(httpByName[name]?.outputSchema, name).toEqual(stdioByName[name]?.outputSchema);
    }
  });

  it("search_companies: identical structuredContent for the same input", async () => {
    const args = { query: "AI", limit: 5 };
    const [stdio, http] = await Promise.all([
      stdioClient.callTool({ name: "search_companies", arguments: args }),
      httpClient.callTool({ name: "search_companies", arguments: args }),
    ]);
    expect(http.structuredContent).toEqual(stdio.structuredContent);
  });

  it("get_company: identical structuredContent for a known id, and identical error shape for an unknown one", async () => {
    const [stdioOk, httpOk] = await Promise.all([
      stdioClient.callTool({ name: "get_company", arguments: { companyId: "cmp_1" } }),
      httpClient.callTool({ name: "get_company", arguments: { companyId: "cmp_1" } }),
    ]);
    expect(httpOk.structuredContent).toEqual(stdioOk.structuredContent);

    const [stdioMissing, httpMissing] = await Promise.all([
      stdioClient.callTool({ name: "get_company", arguments: { companyId: "cmp_nope" } }),
      httpClient.callTool({ name: "get_company", arguments: { companyId: "cmp_nope" } }),
    ]);
    expect(httpMissing.isError).toBe(stdioMissing.isError);
    expect(httpMissing.structuredContent).toEqual(stdioMissing.structuredContent);
  });

  it("search_contacts: identical structuredContent for the same input", async () => {
    const args = { companyId: "cmp_1" };
    const [stdio, http] = await Promise.all([
      stdioClient.callTool({ name: "search_contacts", arguments: args }),
      httpClient.callTool({ name: "search_contacts", arguments: args }),
    ]);
    expect(http.structuredContent).toEqual(stdio.structuredContent);
  });
});
