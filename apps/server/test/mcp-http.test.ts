// Protocol-level MCP tests for the Streamable HTTP transport: a real MCP client connects over real HTTP
// to the real Fastify route, against a real, migrated Postgres database. No service method is called
// directly, and the Fastify auth hook is exercised exactly as it runs in production.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { CompanyDetailSchema, EnrichContactOutputSchema, ExportContactsOutputSchema, SearchCompaniesOutputSchema } from "@aip/contracts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createLogger } from "@aip/core";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { buildMcpHttpApp } from "../src/mcp/http-app.js";
import { buildServices, type BuiltServices } from "../src/mcp/services.js";
import { captureLogs } from "../../../packages/core/test/support/helpers.js";
import { buildMcpFixtures, type McpFixtures } from "./support/mcp-fixtures.js";

let fx: McpFixtures;
let built: BuiltServices;
let app: Awaited<ReturnType<typeof buildMcpHttpApp>>;
let baseUrl = "";
let port = 0;
const logs = captureLogs();

beforeAll(async () => {
  fx = await buildMcpFixtures(inject("templateDb"));
  const logger = createLogger({ level: "info", destination: logs.destination });
  built = buildServices({ databaseUrl: fx.db.url, downloadBaseUrl: "http://127.0.0.1:0", logger });
  app = buildMcpHttpApp(built.services, built.services.apiKeys, logger, { host: "127.0.0.1" });
  await app.app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.app.server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});
afterAll(async () => {
  await app.close();
  await app.app.close();
  await built.db.$disconnect();
  await fx.close();
});

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

function mcpClient(apiKey?: string): { c: Client; t: StreamableHTTPClientTransport } {
  const t = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {},
  });
  const c = new Client({ name: "mcp-test-client", version: "0.0.0" });
  client = c;
  return { c, t };
}

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

function raw(headers: Record<string, string>): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += String(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    req.end(initBody);
  });
}

describe("MCP Streamable HTTP: tool discovery and execution (real client, real database)", () => {
  it("discovers exactly the five product tools", async () => {
    const { c, t } = mcpClient(fx.keys.full);
    await c.connect(t);
    const { tools } = await c.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(
      ["enrich_contact", "export_contacts", "get_company", "search_companies", "search_contacts"].sort(),
    );
  });

  it("search_companies: returns results matching the public contract", async () => {
    const { c, t } = mcpClient(fx.keys.full);
    await c.connect(t);
    const res = await c.callTool({ name: "search_companies", arguments: { limit: 5 } });
    expect(res.isError).toBeFalsy();
    expect(SearchCompaniesOutputSchema.parse(res.structuredContent)).toEqual(res.structuredContent);
  });

  it("get_company: known id succeeds, unknown id returns NOT_FOUND", async () => {
    const { c, t } = mcpClient(fx.keys.full);
    await c.connect(t);
    const ok = await c.callTool({ name: "get_company", arguments: { companyId: "cmp_1" } });
    expect(CompanyDetailSchema.parse(ok.structuredContent)).toMatchObject({ id: "cmp_1" });
    const missing = await c.callTool({ name: "get_company", arguments: { companyId: "cmp_nope" } });
    expect(missing.isError).toBe(true);
    expect((missing.structuredContent as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("enrich_contact and export_contacts succeed against the real services", async () => {
    const { c, t } = mcpClient(fx.keys.full);
    await c.connect(t);
    const enriched = await c.callTool({ name: "enrich_contact", arguments: { contactId: "cnt_1" } });
    expect(EnrichContactOutputSchema.parse(enriched.structuredContent)).toEqual(enriched.structuredContent);

    const exported = await c.callTool({ name: "export_contacts", arguments: { contactIds: ["cnt_1", "cnt_2"] } });
    const out = ExportContactsOutputSchema.parse(exported.structuredContent);
    expect(out.downloadUrl).toMatch(/^https?:\/\/.+\/downloads\/[A-Za-z0-9_-]{43}$/);
  });

  it("rejects invalid tool arguments without running the handler", async () => {
    const { c, t } = mcpClient(fx.keys.full);
    await c.connect(t);
    const res = await c.callTool({ name: "search_contacts", arguments: {} }); // neither companyId nor jobTitle
    expect(res.isError).toBe(true);
  });
});

describe("MCP Streamable HTTP: authentication and authorization", () => {
  it("returns 401 with no credential echoed for missing, invalid, expired or revoked keys", async () => {
    for (const key of [undefined, "not-a-real-key", fx.keys.expired, fx.keys.revoked]) {
      const r = await raw(key ? { authorization: `Bearer ${key}` } : {});
      expect(r.status, String(key)).toBe(401);
      expect(String(r.headers["www-authenticate"])).toMatch(/^Bearer/);
      expect(r.body).toContain("UNAUTHENTICATED");
      if (key) expect(r.body).not.toContain(key);
    }
  });

  it("a connecting client with no/invalid credentials is rejected", async () => {
    for (const key of [undefined, "wrong-key"]) {
      const { c, t } = mcpClient(key);
      await expect(c.connect(t)).rejects.toThrow();
      await c.close().catch(() => undefined);
    }
  });

  it("rejects a tool call when the authenticated key lacks the required scope", async () => {
    const { c, t } = mcpClient(fx.keys.companiesOnly);
    await c.connect(t);
    const res = await c.callTool({ name: "export_contacts", arguments: { contactIds: ["cnt_1"] } });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("a companies-only key is rejected for contacts:enrich but still works for companies:read", async () => {
    const { c, t } = mcpClient(fx.keys.companiesOnly);
    await c.connect(t);
    const forbidden = await c.callTool({ name: "enrich_contact", arguments: { contactId: "cnt_1" } });
    expect(forbidden.isError).toBe(true);
    expect((forbidden.structuredContent as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    const allowed = await c.callTool({ name: "search_companies", arguments: {} });
    expect(allowed.isError).toBeFalsy();
  });

  it("never logs the API key, Authorization header or a download URL/token", async () => {
    const { c, t } = mcpClient(fx.keys.full);
    await c.connect(t);
    const res = await c.callTool({ name: "export_contacts", arguments: { contactIds: ["cnt_1"] } });
    const downloadUrl = (res.structuredContent as { downloadUrl: string }).downloadUrl;
    const text = logs.text();
    expect(text).not.toContain(fx.keys.full);
    expect(text).not.toContain(downloadUrl);
  });
});
