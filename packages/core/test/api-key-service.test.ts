import { createHash } from "node:crypto";
import { ApiKeyMetadataSchema, SCOPES } from "@aip/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  ApiKeyRepository,
  ApiKeyService,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
  createLogger,
  requireScope,
} from "../src/index.js";
import { captureLogs, caught } from "./support/helpers.js";
import { createIsolatedDb, type IsolatedDb } from "./support/test-db.js";

let db: IsolatedDb;
let repo: ApiKeyRepository;
let now: Date;
let service: ApiKeyService;
const logs = captureLogs();

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const KEY_FORMAT = /^aip_[a-z0-9]+_[A-Za-z0-9_-]{43}$/;
const secretOf = (key: string): string => key.slice(key.indexOf("_", 4) + 1);

beforeAll(async () => {
  db = await createIsolatedDb(inject("templateDb"));
  repo = new ApiKeyRepository(db.prisma);
});
afterAll(() => db.drop());
beforeEach(() => {
  now = new Date("2026-11-03T00:00:00.000Z");
  service = new ApiKeyService(repo, { now: () => now, logger: createLogger({ level: "debug", destination: logs.destination }) });
});

describe("ApiKeyService.create", () => {
  it("returns the raw key once, in the aip_<keyId>_<secret> format, with safe metadata", async () => {
    const { key, metadata } = await service.create({ name: "demo", scopes: ["companies:read", "contacts:read"] });
    expect(key).toMatch(KEY_FORMAT);
    expect(key.startsWith(`aip_${metadata.id}_`)).toBe(true);
    expect(ApiKeyMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(metadata).toMatchObject({ name: "demo", scopes: ["companies:read", "contacts:read"], expiresAt: null, revokedAt: null, lastUsedAt: null });
    expect(JSON.stringify(metadata)).not.toContain(secretOf(key));
    expect(metadata).not.toHaveProperty("keyHash");
  });

  it("stores only the SHA-256 of the secret, nowhere the raw key or secret", async () => {
    const { key, metadata } = await service.create({ name: "hashed", scopes: ["companies:read"] });
    const row = await db.prisma.apiKey.findUniqueOrThrow({ where: { id: metadata.id } });
    expect(row.keyHash).toBe(sha256(secretOf(key)));
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(await db.prisma.apiKey.findMany());
    expect(dump).not.toContain(secretOf(key));
    expect(dump).not.toContain(key);
  });

  it("generates distinct secrets with the full 256 bits of entropy", async () => {
    const keys = await Promise.all(Array.from({ length: 20 }, (_, i) => service.create({ name: `k${i}`, scopes: ["companies:read"] })));
    expect(new Set(keys.map((k) => secretOf(k.key))).size).toBe(20);
    expect(new Set(keys.map((k) => k.metadata.id)).size).toBe(20);
    expect(keys.every((k) => secretOf(k.key).length === 43)).toBe(true);
  });

  it("de-duplicates scopes and accepts every defined scope", async () => {
    const { metadata } = await service.create({ name: "all", scopes: [...SCOPES, "companies:read"] });
    expect(metadata.scopes).toEqual([...SCOPES]);
  });

  it("validates name, scopes and expiry", async () => {
    const bad: unknown[] = [
      undefined,
      {},
      { name: "", scopes: ["companies:read"] },
      { name: "   ", scopes: ["companies:read"] },
      { name: "x", scopes: [] },
      { name: "x", scopes: ["admin:everything"] },
      { name: "x", scopes: ["companies:read"], expiresAt: "tomorrow" },
      { name: "x", scopes: ["companies:read"], expiresAt: "2026-11-02T00:00:00.000Z" }, // in the past
    ];
    for (const input of bad) expect(await caught(service.create(input)), JSON.stringify(input)).toBeInstanceOf(ValidationError);
  });
});

describe("ApiKeyService.verify", () => {
  it("accepts a valid key and returns the principal with its scopes", async () => {
    const { key, metadata } = await service.create({ name: "ok", scopes: ["contacts:read", "contacts:export"] });
    expect(await service.verify(key)).toEqual({ keyId: metadata.id, name: "ok", scopes: ["contacts:read", "contacts:export"] });
  });

  it("rejects malformed credentials without touching the database", async () => {
    const { key } = await service.create({ name: "fmt", scopes: ["companies:read"] });
    const bad: Array<string | null | undefined> = [
      undefined, null, "", "   ", "Bearer " + key, key + "x", key.slice(0, -1), key.replace("aip_", "xyz_"),
      "aip__" + secretOf(key), "aip_abc", `aip_${"a".repeat(25)}_short`, "not-a-key",
    ];
    for (const value of bad) {
      const error = await caught(service.verify(value));
      expect(error, String(value)).toBeInstanceOf(UnauthenticatedError);
      expect((error as UnauthenticatedError).code).toBe("UNAUTHENTICATED");
    }
  });

  it("rejects an unknown key id and a wrong secret with the same generic message", async () => {
    const { key, metadata } = await service.create({ name: "x", scopes: ["companies:read"] });
    const unknownId = `aip_cnotarealkeyid000000000_${secretOf(key)}`;
    const wrongSecret = `aip_${metadata.id}_${"A".repeat(43)}`;
    const messages = new Set<string>();
    for (const value of [unknownId, wrongSecret]) {
      const error = await caught(service.verify(value));
      expect(error).toBeInstanceOf(UnauthenticatedError);
      messages.add((error as UnauthenticatedError).message);
    }
    expect(messages.size).toBe(1);
  });

  it("rejects a revoked key, immediately", async () => {
    const { key, metadata } = await service.create({ name: "rev", scopes: ["companies:read"] });
    await service.verify(key);
    await service.revoke(metadata.id);
    expect(await caught(service.verify(key))).toBeInstanceOf(UnauthenticatedError);
  });

  it("rejects an expired key and accepts it just before expiry", async () => {
    const { key } = await service.create({ name: "exp", scopes: ["companies:read"], expiresAt: "2026-11-03T01:00:00.000Z" });
    now = new Date("2026-11-03T00:59:59.000Z");
    await expect(service.verify(key)).resolves.toBeDefined();
    now = new Date("2026-11-03T01:00:00.000Z"); // expiry instant itself is already expired
    expect(await caught(service.verify(key))).toBeInstanceOf(UnauthenticatedError);
    now = new Date("2027-01-01T00:00:00.000Z");
    expect(await caught(service.verify(key))).toBeInstanceOf(UnauthenticatedError);
  });

  it("a key whose hash has been tampered with no longer verifies", async () => {
    const { key, metadata } = await service.create({ name: "tamper", scopes: ["companies:read"] });
    await db.prisma.apiKey.update({ where: { id: metadata.id }, data: { keyHash: sha256("something else") } });
    expect(await caught(service.verify(key))).toBeInstanceOf(UnauthenticatedError);
  });
});

describe("ApiKeyService: lastUsedAt", () => {
  const lastUsed = async (id: string): Promise<Date | null> => (await db.prisma.apiKey.findUniqueOrThrow({ where: { id } })).lastUsedAt;

  it("is null until first use, then set to the time of use", async () => {
    const { key, metadata } = await service.create({ name: "lu", scopes: ["companies:read"] });
    expect(await lastUsed(metadata.id)).toBeNull();
    await service.verify(key);
    expect(await lastUsed(metadata.id)).toEqual(now);
  });

  it("is not rewritten within the interval, and refreshed after it", async () => {
    const { key, metadata } = await service.create({ name: "lu2", scopes: ["companies:read"] });
    const first = now;
    await service.verify(key);
    now = new Date(first.getTime() + 30_000);
    await service.verify(key);
    expect(await lastUsed(metadata.id)).toEqual(first); // 30s < 60s interval: no write
    now = new Date(first.getTime() + 61_000);
    await service.verify(key);
    expect(await lastUsed(metadata.id)).toEqual(now);
  });

  it("is not updated by failed authentication", async () => {
    const { key, metadata } = await service.create({ name: "lu3", scopes: ["companies:read"] });
    await caught(service.verify(`aip_${metadata.id}_${"B".repeat(43)}`));
    expect(await lastUsed(metadata.id)).toBeNull();
    await service.revoke(metadata.id);
    await caught(service.verify(key));
    expect(await lastUsed(metadata.id)).toBeNull();
  });
});

describe("scope enforcement", () => {
  it("passes when the scope is granted and throws FORBIDDEN naming the missing scope otherwise", async () => {
    const { key } = await service.create({ name: "scoped", scopes: ["companies:read"] });
    const principal = await service.verify(key);
    expect(() => requireScope(principal, "companies:read")).not.toThrow();
    for (const missing of ["contacts:read", "contacts:enrich", "contacts:export"] as const) {
      let error: unknown;
      try {
        requireScope(principal, missing);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).code).toBe("FORBIDDEN");
      expect((error as ForbiddenError).message).toContain(missing);
    }
  });

  it("ignores unknown scope strings that are in the database", async () => {
    const { metadata } = await service.create({ name: "legacy", scopes: ["companies:read"] });
    await db.prisma.apiKey.update({ where: { id: metadata.id }, data: { scopes: ["companies:read", "admin:everything"] } });
    const row = await repo.findById(metadata.id);
    expect(row?.scopes).toContain("admin:everything");
    const { key } = await service.create({ name: "legacy2", scopes: ["contacts:read"] });
    expect((await service.verify(key)).scopes).toEqual(["contacts:read"]);
    expect((await service.list()).find((k) => k.id === metadata.id)?.scopes).toEqual(["companies:read"]);
  });
});

describe("ApiKeyService.revoke and list", () => {
  it("revokes, is idempotent, and reports NOT_FOUND for unknown ids", async () => {
    const { metadata } = await service.create({ name: "r", scopes: ["companies:read"] });
    const first = await service.revoke(metadata.id);
    expect(first.revokedAt).toBe(now.toISOString());
    now = new Date("2026-12-01T00:00:00.000Z");
    expect((await service.revoke(metadata.id)).revokedAt).toBe(first.revokedAt); // original time kept
    expect(await caught(service.revoke("does-not-exist"))).toBeInstanceOf(NotFoundError);
  });

  it("lists metadata only: no keys, secrets or hashes", async () => {
    const { key } = await service.create({ name: "listed", scopes: ["companies:read"] });
    const list = await service.list();
    expect(list.length).toBeGreaterThan(0);
    for (const item of list) ApiKeyMetadataSchema.parse(item);
    const json = JSON.stringify(list);
    expect(json).not.toContain(secretOf(key));
    expect(json).not.toContain("keyHash");
    expect(json).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("ApiKeyService logging", () => {
  it("never writes a raw key or secret to the logs, even for rejected keys", async () => {
    const { key, metadata } = await service.create({ name: "logged", scopes: ["companies:read"] });
    await service.verify(key);
    await caught(service.verify(`aip_${metadata.id}_${"C".repeat(43)}`));
    await service.revoke(metadata.id);
    await caught(service.verify(key));
    const text = logs.text();
    expect(text).toContain("api key created");
    expect(text).toContain("api key rejected");
    expect(text).not.toContain(secretOf(key));
    expect(text).not.toContain(key);
    expect(text).not.toContain("C".repeat(43));
  });
});
