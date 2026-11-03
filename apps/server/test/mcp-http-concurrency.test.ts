// P1 (post-review hardening): proves concurrent requests from two different API keys, against one
// running Streamable HTTP server instance, never share or overwrite authorization context. Two
// independent MCP clients, two independent keys with different scopes, real transport, real
// ApiKeyService.verify, real tool handlers -- nothing here is mocked.
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createLogger } from "@aip/core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildMcpHttpApp } from "../src/mcp/http-app.js";
import { buildServices, type BuiltServices } from "../src/mcp/services.js";
import { buildMcpFixtures, keyIdOf, type McpFixtures } from "./support/mcp-fixtures.js";

let fx: McpFixtures;
let built: BuiltServices;
let app: Awaited<ReturnType<typeof buildMcpHttpApp>>;
let baseUrl = "";

beforeAll(async () => {
  fx = await buildMcpFixtures(inject("templateDb"));
  built = buildServices({ databaseUrl: fx.db.url, downloadBaseUrl: "http://127.0.0.1:0", logger: createLogger({ level: "silent" }) });
  app = buildMcpHttpApp(built.services, built.services.apiKeys, createLogger({ level: "silent" }), { host: "127.0.0.1" });
  await app.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.app.server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});
afterAll(async () => {
  await app.close();
  await app.app.close();
  await built.db.$disconnect();
  await fx.close();
});

function connectedClient(name: string, apiKey: string): Promise<Client> {
  const c = new Client({ name, version: "0.0.0" });
  const t = new StreamableHTTPClientTransport(new URL(baseUrl), { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } });
  return c.connect(t).then(() => c);
}

describe("MCP Streamable HTTP: concurrent requests from different principals do not cross-contaminate", () => {
  it("interleaved concurrent calls from a full-scope key and a companies-only key each get only their own outcome", async () => {
    // Key A: every scope. Key B: companies:read only -- lacks contacts:export, the scope under test.
    const [clientA, clientB] = await Promise.all([
      connectedClient("concurrency-A", fx.keys.full),
      connectedClient("concurrency-B", fx.keys.companiesOnly),
    ]);

    const ROUNDS = 25;
    const calls: Promise<{ who: "A" | "B"; isError: boolean | undefined; code: string | undefined }>[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      calls.push(
        clientA.callTool({ name: "export_contacts", arguments: { contactIds: ["cnt_1"] } }).then((r) => ({
          who: "A" as const,
          isError: r.isError,
          code: (r.structuredContent as { error?: { code: string } } | undefined)?.error?.code,
        })),
      );
      calls.push(
        clientB.callTool({ name: "export_contacts", arguments: { contactIds: ["cnt_1"] } }).then((r) => ({
          who: "B" as const,
          isError: r.isError,
          code: (r.structuredContent as { error?: { code: string } } | undefined)?.error?.code,
        })),
      );
    }
    const results = await Promise.all(calls);

    const aResults = results.filter((r) => r.who === "A");
    const bResults = results.filter((r) => r.who === "B");
    expect(aResults).toHaveLength(ROUNDS);
    expect(bResults).toHaveLength(ROUNDS);

    // 1 & 3: A (full scope) must succeed every single time -- never see B's FORBIDDEN.
    for (const r of aResults) expect(r.isError).toBeFalsy();
    // 2 & 4: B (companies:read only) must be forbidden every single time -- never see A's success.
    for (const r of bResults) {
      expect(r.isError).toBe(true);
      expect(r.code).toBe("FORBIDDEN");
    }

    // 5: a DB-level check that no concurrent request's principal leaked into another's write --
    // every export_contacts call that actually created a row must have been authored by A's keyId,
    // never B's (B's calls never reached ExportService at all, since requireScope rejects first).
    const aKeyId = keyIdOf(fx.keys.full);
    const bKeyId = keyIdOf(fx.keys.companiesOnly);
    const jobs = await built.db.exportJob.findMany({ where: { createdAt: { gte: new Date(Date.now() - 60_000) } } });
    expect(jobs.length).toBeGreaterThanOrEqual(ROUNDS);
    expect(jobs.every((j) => j.apiKeyId === aKeyId)).toBe(true);
    expect(jobs.some((j) => j.apiKeyId === bKeyId)).toBe(false);

    await clientA.close();
    await clientB.close();
  });

  it("concurrent calls to a scope both keys share (companies:read) both succeed independently", async () => {
    const [clientA, clientB] = await Promise.all([
      connectedClient("concurrency-A2", fx.keys.full),
      connectedClient("concurrency-B2", fx.keys.companiesOnly),
    ]);
    const [a, b] = await Promise.all([
      clientA.callTool({ name: "search_companies", arguments: { limit: 3 } }),
      clientB.callTool({ name: "search_companies", arguments: { limit: 3 } }),
    ]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(a.structuredContent).toEqual(b.structuredContent); // same data, same query -- just proving both resolved correctly, independently

    await clientA.close();
    await clientB.close();
  });
});
