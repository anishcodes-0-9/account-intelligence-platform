// P2 (post-review hardening): Host/Origin and malformed-request regression tests against the real
// buildMcpHttpApp(), ported from the deleted M1 spike suite (docs/decisions/0001). These exercise
// `createMcpFastifyApp`'s and Fastify's own built-in protections -- no custom middleware is added here;
// this only proves the protection is still in effect on the real app, not a re-implementation of it.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "@aip/core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildMcpHttpApp } from "../src/mcp/http-app.js";
import { buildServices, type BuiltServices } from "../src/mcp/services.js";
import { buildMcpFixtures, type McpFixtures } from "./support/mcp-fixtures.js";

let fx: McpFixtures;
let built: BuiltServices;
let app: Awaited<ReturnType<typeof buildMcpHttpApp>>;
let port = 0;

beforeAll(async () => {
  fx = await buildMcpFixtures(inject("templateDb"));
  built = buildServices({ databaseUrl: fx.db.url, downloadBaseUrl: "http://127.0.0.1:0", logger: createLogger({ level: "silent" }) });
  app = buildMcpHttpApp(built.services, built.services.apiKeys, createLogger({ level: "silent" }), { host: "127.0.0.1" });
  await app.app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.app.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await app.close();
  await app.app.close();
  await built.db.$disconnect();
  await fx.close();
});

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

function raw(headers: Record<string, string>, body = initBody): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
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
    req.end(body);
  });
}

describe("MCP Streamable HTTP: Host and Origin protection (DNS rebinding)", () => {
  it("rejects an invalid Host header with 403, before our auth hook even runs", async () => {
    // No credentials on purpose: a 403 (not 401) proves Host validation runs before our Bearer check.
    expect((await raw({ host: "evil.example.com" })).status).toBe(403);
    expect((await raw({ authorization: `Bearer ${fx.keys.full}`, host: "evil.example.com" })).status).toBe(403);
  });

  it("rejects a non-local Origin, admits a local or absent Origin", async () => {
    const auth = { authorization: `Bearer ${fx.keys.full}` };
    expect((await raw({ origin: "https://evil.example.com" })).status).toBe(403);
    expect((await raw({ ...auth, origin: "https://evil.example.com" })).status).toBe(403);
    expect((await raw({ ...auth, origin: "http://localhost:5173" })).status).toBe(200);
    expect((await raw({ ...auth })).status).toBe(200);
  });
});

describe("MCP Streamable HTTP: malformed requests", () => {
  it("handles malformed JSON, wrong Content-Type, and valid-JSON-non-RPC without a 500 or a leak", async () => {
    const auth = { authorization: `Bearer ${fx.keys.full}` };
    const malformed = await raw(auth, "{not json");
    const wrongType = await raw({ ...auth, "content-type": "text/plain" });
    const notRpc = await raw(auth, JSON.stringify({ hello: "world" }));
    for (const r of [malformed, wrongType, notRpc]) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(r.body).not.toContain(fx.keys.full);
    }
  });
});
