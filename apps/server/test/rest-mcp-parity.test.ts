// Confirms REST and MCP are two thin adapters over the same core services, not two implementations:
// identical input through each transport must produce identical service-level data. Both run against
// one real Fastify app (buildHttpApp) serving /mcp and /api/* together, over one real database.
import type { AddressInfo } from "node:net";
import { createLogger } from "@aip/core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildHttpApp } from "../src/http-app.js";
import { buildServices, type BuiltServices } from "../src/mcp/services.js";
import { buildMcpFixtures, type McpFixtures } from "./support/mcp-fixtures.js";

let fx: McpFixtures;
let built: BuiltServices;
let app: Awaited<ReturnType<typeof buildHttpApp>>;
let baseUrl = "";

beforeAll(async () => {
  fx = await buildMcpFixtures(inject("templateDb"));
  built = buildServices({ databaseUrl: fx.db.url, downloadBaseUrl: "http://127.0.0.1:0", logger: createLogger({ level: "silent" }) });
  app = buildHttpApp(built.services, createLogger({ level: "silent" }), { host: "127.0.0.1" });
  await app.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.app.server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await app.close();
  await app.app.close();
  await built.db.$disconnect();
  await fx.close();
});

function getJson(path: string, apiKey: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: "GET", headers: { authorization: `Bearer ${apiKey}` } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += String(c)));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("REST and MCP use the same core service behavior", () => {
  it("search_companies (MCP) and GET /api/companies (REST) return identical data for the same query", async () => {
    const c = new Client({ name: "parity-test", version: "0.0.0" });
    const t = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${fx.keys.full}` } } });
    await c.connect(t);
    const mcpResult = await c.callTool({ name: "search_companies", arguments: { limit: 7 } });
    await c.close();

    const restResult = await getJson("/api/companies?limit=7", fx.keys.full);
    expect(restResult).toEqual(mcpResult.structuredContent);
  });

  it("get_company (MCP) and GET /api/companies/:companyId (REST) return identical data", async () => {
    const c = new Client({ name: "parity-test-2", version: "0.0.0" });
    const t = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${fx.keys.full}` } } });
    await c.connect(t);
    const mcpResult = await c.callTool({ name: "get_company", arguments: { companyId: "cmp_1" } });
    await c.close();

    const restResult = await getJson("/api/companies/cmp_1", fx.keys.full);
    expect(restResult).toEqual(mcpResult.structuredContent);
  });

  it("enforces the identical scope rule: a companies-only key is FORBIDDEN/403 on contacts:export in both transports", async () => {
    const c = new Client({ name: "parity-test-3", version: "0.0.0" });
    const t = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${fx.keys.companiesOnly}` } } });
    await c.connect(t);
    const mcpResult = await c.callTool({ name: "export_contacts", arguments: { contactIds: ["cnt_1"] } });
    await c.close();
    expect((mcpResult.structuredContent as { error: { code: string } }).error.code).toBe("FORBIDDEN");

    const restResult = await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
      const payload = JSON.stringify({ contactIds: ["cnt_1"] });
      const req = request(
        `${baseUrl}/api/contacts/export`,
        { method: "POST", headers: { authorization: `Bearer ${fx.keys.companiesOnly}`, "content-type": "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (c2) => (data += String(c2)));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    expect(restResult.status).toBe(403);
    expect((restResult.json as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });
});
