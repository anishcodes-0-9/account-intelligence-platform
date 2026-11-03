// Integration tests for the M6 REST API: a real HTTP client against the real Fastify app (built the
// same way the /mcp route is, via buildHttpApp) and a real, migrated, isolated Postgres database.
// No service method is called directly -- every assertion goes through an actual HTTP request.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "@aip/core";
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

interface RawResponse {
  status: number;
  headers: Record<string, unknown>;
  json: unknown;
}

function call(method: string, path: string, opts: { apiKey?: string; body?: unknown; rawBody?: string; contentType?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    let payload: string | undefined;
    if (opts.rawBody !== undefined) {
      payload = opts.rawBody;
      headers["content-type"] = opts.contentType ?? "application/json";
    } else if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    const req = request(`${baseUrl}${path}`, { method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += String(c)));
      res.on("end", () => {
        let json: unknown;
        try {
          json = data ? JSON.parse(data) : undefined;
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.end(payload);
    else req.end();
  });
}

describe("REST: GET /api/companies", () => {
  it("searches companies for an authenticated key with companies:read", async () => {
    const r = await call("GET", "/api/companies?limit=5", { apiKey: fx.keys.full });
    expect(r.status).toBe(200);
    expect(r.json).toHaveProperty("results");
    expect((r.json as { results: unknown[] }).results.length).toBeLessThanOrEqual(5);
  });

  it("rejects an out-of-range limit as a validation failure", async () => {
    const r = await call("GET", "/api/companies?limit=0", { apiKey: fx.keys.full });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("REST: GET /api/companies/:companyId", () => {
  it("returns a known company", async () => {
    const r = await call("GET", "/api/companies/cmp_1", { apiKey: fx.keys.full });
    expect(r.status).toBe(200);
    expect((r.json as { id: string }).id).toBe("cmp_1");
  });

  it("returns 404 NOT_FOUND for an unknown company", async () => {
    const r = await call("GET", "/api/companies/cmp_nope", { apiKey: fx.keys.full });
    expect(r.status).toBe(404);
    expect((r.json as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });
});

describe("REST: GET /api/contacts", () => {
  it("searches contacts by companyId", async () => {
    const r = await call("GET", "/api/contacts?companyId=cmp_1", { apiKey: fx.keys.full });
    expect(r.status).toBe(200);
    expect(r.json).toHaveProperty("contacts");
  });

  it("rejects when neither companyId nor jobTitle is given (service-level ValidationError)", async () => {
    const r = await call("GET", "/api/contacts", { apiKey: fx.keys.full });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("REST: POST /api/contacts/:contactId/enrich", () => {
  it("enriches a known contact", async () => {
    const r = await call("POST", "/api/contacts/cnt_1/enrich", { apiKey: fx.keys.full });
    expect(r.status).toBe(200);
    expect(r.json).toHaveProperty("status");
  });

  it("returns 404 NOT_FOUND for an unknown contact", async () => {
    const r = await call("POST", "/api/contacts/cnt_nope/enrich", { apiKey: fx.keys.full });
    expect(r.status).toBe(404);
    expect((r.json as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("is forbidden for a key lacking contacts:enrich", async () => {
    const r = await call("POST", "/api/contacts/cnt_1/enrich", { apiKey: fx.keys.companiesOnly });
    expect(r.status).toBe(403);
    expect((r.json as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });
});

describe("REST: POST /api/contacts/export", () => {
  it("exports known contacts to a usable download URL", async () => {
    const r = await call("POST", "/api/contacts/export", { apiKey: fx.keys.full, body: { contactIds: ["cnt_1", "cnt_2"] } });
    expect(r.status).toBe(200);
    const body = r.json as { downloadUrl: string; rowCount: number };
    expect(body.rowCount).toBe(2);
    expect(body.downloadUrl).toMatch(/\/downloads\/[A-Za-z0-9_-]{43}$/);
  });

  it("returns NOT_FOUND (all-or-nothing) if any contact id is unknown", async () => {
    const r = await call("POST", "/api/contacts/export", { apiKey: fx.keys.full, body: { contactIds: ["cnt_1", "cnt_nope"] } });
    expect(r.status).toBe(404);
    expect((r.json as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed JSON as a validation failure, not a 500", async () => {
    const r = await call("POST", "/api/contacts/export", { apiKey: fx.keys.full, rawBody: "{not json" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it("is forbidden for a key lacking contacts:export", async () => {
    const r = await call("POST", "/api/contacts/export", { apiKey: fx.keys.companiesOnly, body: { contactIds: ["cnt_1"] } });
    expect(r.status).toBe(403);
    expect((r.json as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });
});

describe("REST: authentication", () => {
  it("rejects every protected endpoint without a valid key (401, no credential echoed)", async () => {
    for (const key of [undefined, "not-a-real-key", fx.keys.expired, fx.keys.revoked]) {
      const r = await call("GET", "/api/companies", key ? { apiKey: key } : {});
      expect(r.status, String(key)).toBe(401);
      expect(String(r.headers["www-authenticate"])).toMatch(/^Bearer/);
      expect((r.json as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
      if (key) expect(JSON.stringify(r.json)).not.toContain(key);
    }
  });
});
