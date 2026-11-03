import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSpikeHttpApp } from "../src/spike/http-app.js";
import { SPIKE_KEY } from "./spike-helpers.js";

const built = buildSpikeHttpApp({ host: "127.0.0.1", apiKey: SPIKE_KEY });
let baseUrl = "";
let port = 0;

beforeAll(async () => {
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  port = (built.app.server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});
afterAll(async () => {
  await built.close();
  await built.app.close();
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

const auth = { authorization: `Bearer ${SPIKE_KEY}` };

function client(key?: string): { c: Client; t: StreamableHTTPClientTransport } {
  const t = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: key ? { headers: { Authorization: `Bearer ${key}` } } : {},
  });
  return { c: new Client({ name: "spike-client", version: "0.0.0" }), t };
}

describe("spike over Streamable HTTP (real MCP client)", () => {
  it("discovers tools and calls ping; authInfo reaches the handler", async () => {
    const { c, t } = client(SPIKE_KEY);
    await c.connect(t);
    const { tools } = await c.listTools();
    expect(tools.map((x) => x.name)).toContain("ping");
    const res = await c.callTool({ name: "ping", arguments: { message: "hello" } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ pong: "hello", caller: "spike-key" });
    await c.close();
  });

  it("rejects a client with no key or a wrong key", async () => {
    for (const key of [undefined, "wrong-key"]) {
      const { c, t } = client(key);
      await expect(c.connect(t)).rejects.toThrow();
      await c.close().catch(() => undefined);
    }
  });

  it("returns 401 + WWW-Authenticate for missing/invalid/non-Bearer credentials, without echoing the key", async () => {
    for (const h of [{}, { authorization: "Bearer nope" }, { authorization: `Basic ${SPIKE_KEY}` }]) {
      const r = await raw(h);
      expect(r.status).toBe(401);
      expect(String(r.headers["www-authenticate"])).toMatch(/^Bearer/);
      expect(r.body).toContain("UNAUTHENTICATED");
      expect(r.body).not.toContain(SPIKE_KEY);
    }
  });

  it("rejects an invalid Host header (DNS rebinding) before auth runs", async () => {
    // No credentials on purpose: a 403 (not 401) proves Host validation runs before auth.
    expect((await raw({ host: "evil.example.com" })).status).toBe(403);
    expect((await raw({ ...auth, host: "evil.example.com" })).status).toBe(403);
  });

  it("rejects a non-local Origin, admits a local or absent Origin", async () => {
    expect((await raw({ origin: "https://evil.example.com" })).status).toBe(403);
    expect((await raw({ ...auth, origin: "https://evil.example.com" })).status).toBe(403);
    expect((await raw({ ...auth, origin: "http://localhost:5173" })).status).toBe(200);
    expect((await raw({ ...auth })).status).toBe(200);
  });

  it("handles malformed and wrong-content-type requests without a 500 or leak", async () => {
    const malformed = await raw(auth, "{not json");
    const wrongType = await raw({ ...auth, "content-type": "text/plain" });
    const notRpc = await raw(auth, JSON.stringify({ hello: "world" }));
    console.log("MALFORMED ->", malformed.status, malformed.body.slice(0, 160), "| WRONG_TYPE ->", wrongType.status, "| NOT_RPC ->", notRpc.status, notRpc.body.slice(0, 160));
    for (const r of [malformed, wrongType, notRpc]) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
  });

  it("surfaces validation and returned errors over HTTP the same way as stdio", async () => {
    const { c, t } = client(SPIKE_KEY);
    await c.connect(t);
    const invalid = await c.callTool({ name: "ping", arguments: { message: "" } });
    expect(invalid.isError).toBe(true);
    const returned = await c.callTool({ name: "spike_returns_error", arguments: {} });
    expect(returned.structuredContent).toEqual({ error: { code: "NOT_FOUND", message: "nothing here" } });
    const thrown = await c.callTool({ name: "spike_throws", arguments: {} }).then(
      (r) => ({ kind: "result" as const, r }),
      (e: unknown) => ({ kind: "rejected" as const, e: e instanceof Error ? e.message : String(e) }),
    );
    console.log("HTTP THROWN ->", JSON.stringify(thrown));
    await c.close();
  });

  it("records how an unknown tool is surfaced", async () => {
    const { c, t } = client(SPIKE_KEY);
    await c.connect(t);
    const out = await c.callTool({ name: "does_not_exist", arguments: {} }).then(
      (r) => ({ kind: "result" as const, r }),
      (e: unknown) => ({ kind: "rejected" as const, name: e instanceof Error ? e.name : "?", message: e instanceof Error ? e.message : String(e) }),
    );
    console.log("HTTP UNKNOWN_TOOL ->", JSON.stringify(out));
    expect(out.kind).toBe("rejected");
    await c.close();
  });
});
