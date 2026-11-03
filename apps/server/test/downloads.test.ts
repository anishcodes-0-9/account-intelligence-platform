// Integration tests for GET /downloads/:token: a real HTTP client against the real Fastify route
// (registerDownloadRoute, mounted by buildHttpApp exactly as production does), backed by
// ExportService.download -- the same method export_contacts (MCP) and POST /api/contacts/export
// (REST) create tokens for. No business logic is duplicated or mocked here.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { ContactRepository, createLogger, ExportRepository, ExportService } from "@aip/core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildHttpApp } from "../src/http-app.js";
import { buildServices, type BuiltServices } from "../src/mcp/services.js";
import { registerDownloadRoute } from "../src/rest/downloads.js";
import { buildMcpFixtures, keyIdOf, type McpFixtures } from "./support/mcp-fixtures.js";

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

interface RawResponse {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

function get(path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: "GET" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += String(c)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("GET /downloads/:token: success path and content", () => {
  it("serves the CSV created by export_contacts (MCP) with correct headers", async () => {
    const c = new Client({ name: "download-test", version: "0.0.0" });
    const t = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${fx.keys.full}` } } });
    await c.connect(t);
    const res = await c.callTool({ name: "export_contacts", arguments: { contactIds: ["cnt_1", "cnt_2"] } });
    const { downloadUrl, rowCount } = res.structuredContent as { downloadUrl: string; rowCount: number };
    await c.close();

    const path = new URL(downloadUrl).pathname;
    const r = await get(path);
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"])).toContain("text/csv");
    expect(String(r.headers["content-disposition"])).toMatch(/attachment/);
    const lines = r.body.trim().split("\n");
    expect(lines.length).toBe(rowCount + 1); // header + rows
  });

  it("serves the CSV created by POST /api/contacts/export (REST), proving both transports share one export store", async () => {
    const exportRes = await new Promise<RawResponse & { json: unknown }>((resolve, reject) => {
      const payload = JSON.stringify({ contactIds: ["cnt_1"] });
      const req = request(
        `${baseUrl}/api/contacts/export`,
        { method: "POST", headers: { authorization: `Bearer ${fx.keys.full}`, "content-type": "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += String(c)));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data, json: JSON.parse(data) }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    const { downloadUrl } = exportRes.json as { downloadUrl: string };
    const r = await get(new URL(downloadUrl).pathname);
    expect(r.status).toBe(200);
    expect(r.body).toContain("cnt_1");
  });
});

describe("GET /downloads/:token: unknown, malformed and expired tokens are indistinguishable", () => {
  it("unknown (well-formed but never issued) and malformed tokens both 404 with the same body", async () => {
    const unknown = await get(`/downloads/${"A".repeat(43)}`);
    const malformed = await get("/downloads/not-a-real-token");
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual(JSON.parse(malformed.body));
  });

  it("an expired export's token 404s identically to an unknown one", async () => {
    // A second, standalone app wired to the same database but with a controllable clock, so the
    // 15-minute TTL can be crossed instantly instead of waiting on real wall-clock time. This is the
    // same `now` injection point packages/core/test/export-service.test.ts already uses at the service
    // level; here it is exercised through the real HTTP download route instead of calling the service
    // method directly.
    let clock = new Date();
    const contacts = new ContactRepository(built.db);
    const exportsRepo = new ExportRepository(built.db);
    const exportService = new ExportService(contacts, exportsRepo, {
      downloadBaseUrl: "http://127.0.0.1:0",
      now: () => clock,
      logger: createLogger({ level: "silent" }),
    });
    const clockApp = Fastify({ logger: false });
    registerDownloadRoute(clockApp, exportService, createLogger({ level: "silent" }));
    await clockApp.listen({ host: "127.0.0.1", port: 0 });
    const clockPort = (clockApp.server.address() as AddressInfo).port;
    const clockBase = `http://127.0.0.1:${clockPort}`;

    const out = await exportService.export({ keyId: keyIdOf(fx.keys.full), name: "test", scopes: ["contacts:export"] }, { contactIds: ["cnt_1"] });
    const token = new URL(out.downloadUrl).pathname.split("/").pop()!;

    const fresh = await new Promise<RawResponse>((resolve, reject) => {
      const req = request(`${clockBase}/downloads/${token}`, { method: "GET" }, (res) => {
        let data = "";
        res.on("data", (c) => (data += String(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(fresh.status).toBe(200);

    clock = new Date(clock.getTime() + 15 * 60_000 + 1);
    const afterExpiry = await new Promise<RawResponse>((resolve, reject) => {
      const req = request(`${clockBase}/downloads/${token}`, { method: "GET" }, (res) => {
        let data = "";
        res.on("data", (c) => (data += String(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      });
      req.on("error", reject);
      req.end();
    });
    const unknown = await new Promise<RawResponse>((resolve, reject) => {
      const req = request(`${clockBase}/downloads/${"B".repeat(43)}`, { method: "GET" }, (res) => {
        let data = "";
        res.on("data", (c) => (data += String(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(afterExpiry.status).toBe(404);
    expect(JSON.parse(afterExpiry.body)).toEqual(JSON.parse(unknown.body));

    await clockApp.close();
  });
});
