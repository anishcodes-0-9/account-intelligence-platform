// P1 (post-review hardening): proves a key revoked mid-session is rejected on the very next request,
// over the client's existing, already-connected session -- not just at the next fresh connect. Real
// transport, real ApiKeyService.revoke, no mocking.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createLogger } from "@aip/core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildMcpHttpApp } from "../src/mcp/http-app.js";
import { buildServices, type BuiltServices } from "../src/mcp/services.js";
import { buildMcpFixtures, type McpFixtures } from "./support/mcp-fixtures.js";

let fx: McpFixtures;
let built: BuiltServices;
let app: Awaited<ReturnType<typeof buildMcpHttpApp>>;
let baseUrl = "";
let port = 0;

beforeAll(async () => {
  fx = await buildMcpFixtures(inject("templateDb"));
  built = buildServices({ databaseUrl: fx.db.url, downloadBaseUrl: "http://127.0.0.1:0", logger: createLogger({ level: "silent" }) });
  app = buildMcpHttpApp(built.services, built.services.apiKeys, createLogger({ level: "silent" }), { host: "127.0.0.1" });
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

function rawPost(body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += String(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("MCP Streamable HTTP: mid-session key revocation", () => {
  it("1-6: a key revoked after a successful call is rejected on the client's very next call over the same, never-reconnected session", async () => {
    // 1: create a dedicated key for this test (never shared with other test files, so revoking it here
    // cannot affect any other test).
    const created = await fx.apiKeyService.create({ name: "mid-session-revoke", scopes: ["companies:read"] });

    // 2: connect and successfully execute an authorized tool.
    const client = new Client({ name: "revocation-test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${created.key}` } },
    });
    await client.connect(transport);
    const before = await client.callTool({ name: "search_companies", arguments: {} });
    expect(before.isError).toBeFalsy();

    // 3: revoke that same key via the real ApiKeyService -- no new key, no reconnect.
    await fx.apiKeyService.revoke(created.metadata.id);

    // 4 & 5: the client's existing session (same transport instance, same client object, never
    // reconnected) makes another tool call. It must be rejected, not silently succeed.
    await expect(client.callTool({ name: "search_companies", arguments: {} })).rejects.toThrow();

    // 6: confirm precisely *why* at the transport level -- a direct request carrying the now-revoked
    // key gets 401 UNAUTHENTICATED, proving the key is re-verified on this request, not cached from step 2.
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "search_companies", arguments: {} },
    });
    const direct = await rawPost(initBody, { authorization: `Bearer ${created.key}` });
    expect(direct.status).toBe(401);
    expect(direct.body).toContain("UNAUTHENTICATED");
    expect(direct.body).not.toContain(created.key);

    await client.close().catch(() => undefined);
  });
});
