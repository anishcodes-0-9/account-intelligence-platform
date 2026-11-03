import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ApiKeyRepository,
  CompanyRepository,
  ContactRepository,
  EnrichmentRepository,
  ExportRepository,
} from "../src/index.js";
import { createIsolatedDb, type IsolatedDb } from "./support/test-db.js";

let db: IsolatedDb;
let companies: CompanyRepository;
let contacts: ContactRepository;
let enrichments: EnrichmentRepository;
let apiKeys: ApiKeyRepository;
let exports_: ExportRepository;

const company = (id: string, over: Partial<{ name: string; industry: string; country: string; description: string; employees: number }> = {}) => ({
  id,
  name: over.name ?? `Co ${id}`,
  website: `https://${id}.example`,
  industry: over.industry ?? "Software",
  employees: over.employees ?? 100,
  country: over.country ?? "Australia",
  description: over.description ?? "A synthetic company.",
});
const contact = (id: string, companyId: string, jobTitle: string, fullName = `Person ${id}`) => ({
  id,
  companyId,
  firstName: fullName.split(" ")[0] ?? "",
  lastName: fullName.split(" ")[1] ?? "",
  fullName,
  jobTitle,
});

beforeAll(async () => {
  db = await createIsolatedDb(inject("templateDb"));
  companies = new CompanyRepository(db.prisma);
  contacts = new ContactRepository(db.prisma);
  enrichments = new EnrichmentRepository(db.prisma);
  apiKeys = new ApiKeyRepository(db.prisma);
  exports_ = new ExportRepository(db.prisma);

  await companies.create(company("c1", { name: "Alpha Labs", industry: "Artificial Intelligence", description: "AI assistants for support teams." }));
  await companies.create(company("c2", { name: "Beta Works", industry: "Logistics", country: "New Zealand", description: "Freight routing." }));
  await companies.create(company("c3", { name: "Gamma Group", industry: "Artificial Intelligence", country: "New Zealand", description: "Vision models." }));
  await contacts.create(contact("k1", "c1", "Senior Engineer", "Ada Lovelace"));
  await contacts.create(contact("k2", "c1", "Chief Technology Officer", "Bo Peep"));
  await contacts.create(contact("k3", "c2", "Staff ENGINEER", "Cy Young"));
});
afterAll(() => db.drop());

describe("CompanyRepository", () => {
  it("creates and retrieves a company; unknown id is null", async () => {
    const found = await companies.findById("c1");
    expect(found).toMatchObject({ id: "c1", name: "Alpha Labs", employees: 100, country: "Australia" });
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(await companies.findById("nope")).toBeNull();
  });

  it("requires every term to match across name/industry/description, case-insensitively", async () => {
    const names = async (terms: string[], country?: string) => (await companies.search({ terms, country, limit: 10 })).map((c) => c.id);
    expect(await names(["ai"])).toEqual(["c1"]); // description only
    expect(await names(["artificial", "support"])).toEqual(["c1"]); // industry + description
    expect(await names(["ALPHA"])).toEqual(["c1"]); // name, upper case
    expect(await names(["artificial", "freight"])).toEqual([]); // terms must all match
    expect(await names([])).toHaveLength(3); // no terms: no text filter
  });

  it("filters by country (case-insensitive) and honours limit", async () => {
    const r = await companies.search({ terms: ["artificial"], country: "new zealand", limit: 10 });
    expect(r.map((c) => c.id)).toEqual(["c3"]);
    expect(await companies.search({ terms: [], limit: 2 })).toHaveLength(2);
  });
});

describe("ContactRepository", () => {
  it("persists optional fields as null and stores values when given", async () => {
    const bare = await contacts.findById("k1");
    expect(bare).toMatchObject({ email: null, linkedin: null });
    const withValues = await contacts.create({ ...contact("k4", "c3", "Analyst"), email: "z@example.com", linkedin: "https://example.com/in/z" });
    expect(withValues).toMatchObject({ email: "z@example.com", linkedin: "https://example.com/in/z" });
  });

  it("loads the company relationship", async () => {
    const k = await contacts.findById("k2");
    expect(k?.company).toMatchObject({ id: "c1", name: "Alpha Labs" });
    expect(await contacts.findById("nope")).toBeNull();
  });

  it("rejects a contact for a non-existent company, and deleting a company that has contacts", async () => {
    await expect(contacts.create(contact("bad", "missing", "X"))).rejects.toThrow();
    await expect(db.prisma.company.delete({ where: { id: "c1" } })).rejects.toThrow();
  });

  it("searches by company and/or case-insensitive job title, with a limit", async () => {
    const ids = async (p: { companyId?: string; jobTitle?: string }) => (await contacts.search({ ...p, limit: 50 })).map((c) => c.id).sort();
    expect(await ids({ companyId: "c1" })).toEqual(["k1", "k2"]);
    expect(await ids({ jobTitle: "engineer" })).toEqual(["k1", "k3"]);
    expect(await ids({ companyId: "c1", jobTitle: "ENGINEER" })).toEqual(["k1"]);
    expect(await ids({ companyId: "c2", jobTitle: "cto" })).toEqual([]);
    expect(await contacts.search({ jobTitle: "engineer", limit: 1 })).toHaveLength(1);
  });

  it("findByIds returns only existing contacts, with their company", async () => {
    const found = await contacts.findByIds(["k1", "k3", "does-not-exist"]);
    expect(found.map((c) => c.id).sort()).toEqual(["k1", "k3"]);
    expect(found.every((c) => c.company.id.length > 0)).toBe(true);
  });

  it("updateEnrichedFields writes only the provided fields", async () => {
    await contacts.create(contact("k5", "c2", "Designer"));
    await contacts.updateEnrichedFields("k5", { email: "d@example.com" });
    expect(await contacts.findById("k5")).toMatchObject({ email: "d@example.com", linkedin: null });
    await contacts.updateEnrichedFields("k5", { linkedin: "https://example.com/in/d" });
    expect(await contacts.findById("k5")).toMatchObject({ email: "d@example.com", linkedin: "https://example.com/in/d" });
    await contacts.updateEnrichedFields("k5", { email: null });
    expect(await contacts.findById("k5")).toMatchObject({ email: null, linkedin: "https://example.com/in/d" });
  });
});

describe("EnrichmentRepository", () => {
  it("persists JSON payloads and the optional error field", async () => {
    const returned = { email: "a@example.com", linkedin: null, nested: { n: [1, 2] } };
    const provenance = [{ field: "email", source: "mock-fixture", synthetic: true, verified: false }];
    const ok = await enrichments.create({ contactId: "k1", provider: "mock", status: "SUCCESS", returned, provenance });
    expect(ok.error).toBeNull();
    expect(ok.returned).toEqual(returned);
    expect(ok.provenance).toEqual(provenance);
    const failed = await enrichments.create({ contactId: "k1", provider: "mock", status: "FAILED", returned: {}, provenance: [], error: "timeout" });
    expect(failed).toMatchObject({ status: "FAILED", error: "timeout" });
  });

  it("lists a contact's records newest first and cascades on contact delete", async () => {
    const list = await enrichments.listForContact("k1");
    expect(list.map((r) => r.status)).toEqual(["FAILED", "SUCCESS"]);
    expect(await enrichments.listForContact("k2")).toEqual([]);
    await contacts.create(contact("k6", "c3", "Temp"));
    await enrichments.create({ contactId: "k6", provider: "mock", status: "NOT_FOUND", returned: {}, provenance: [] });
    await db.prisma.contact.delete({ where: { id: "k6" } });
    expect(await enrichments.listForContact("k6")).toEqual([]);
  });

  it("rejects a record for an unknown contact", async () => {
    await expect(enrichments.create({ contactId: "ghost", provider: "mock", status: "SUCCESS", returned: {}, provenance: [] })).rejects.toThrow();
  });
});

describe("ApiKeyRepository", () => {
  it("persists a key with scopes and optional dates, never a raw key", async () => {
    const key = await apiKeys.create({ name: "demo", keyHash: "hash-1", scopes: ["companies:read", "contacts:read"] });
    expect(key).toMatchObject({ name: "demo", keyHash: "hash-1", scopes: ["companies:read", "contacts:read"], expiresAt: null, revokedAt: null, lastUsedAt: null });
    const expiring = await apiKeys.create({ name: "tmp", keyHash: "hash-2", scopes: [], expiresAt: new Date("2030-01-01T00:00:00Z") });
    expect(expiring.expiresAt?.toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(await apiKeys.findById(key.id)).toMatchObject({ id: key.id });
    expect(await apiKeys.findById("nope")).toBeNull();
  });

  it("enforces a unique keyHash", async () => {
    await expect(apiKeys.create({ name: "dup", keyHash: "hash-1", scopes: [] })).rejects.toThrow(/Unique constraint|unique/i);
  });

  it("records last use and revocation", async () => {
    const key = await apiKeys.create({ name: "rev", keyHash: "hash-3", scopes: ["contacts:export"] });
    const at = new Date("2026-11-03T00:00:00Z");
    expect((await apiKeys.markUsed(key.id, at)).lastUsedAt).toEqual(at);
    expect((await apiKeys.revoke(key.id, at)).revokedAt).toEqual(at);
  });
});

describe("ExportRepository", () => {
  const future = new Date(Date.now() + 15 * 60_000);

  it("persists an export job and finds it by token hash", async () => {
    const key = await apiKeys.create({ name: "exporter", keyHash: "hash-exp", scopes: ["contacts:export"] });
    const job = await exports_.create({ apiKeyId: key.id, contactIds: ["k1", "k2"], rowCount: 2, content: "id,name\nk1,Ada\n", tokenHash: "tok-1", expiresAt: future });
    expect(job).toMatchObject({ apiKeyId: key.id, contactIds: ["k1", "k2"], rowCount: 2, content: "id,name\nk1,Ada\n" });
    expect(await exports_.findByTokenHash("tok-1")).toMatchObject({ id: job.id });
    expect(await exports_.findByTokenHash("unknown")).toBeNull();
    await expect(exports_.create({ apiKeyId: key.id, contactIds: ["k1"], rowCount: 1, content: "x", tokenHash: "tok-1", expiresAt: future })).rejects.toThrow();
  });

  it("rejects invalid rows: unknown api key, empty id list, negative row count", async () => {
    const key = await apiKeys.create({ name: "e2", keyHash: "hash-e2", scopes: [] });
    const base = { apiKeyId: key.id, contactIds: ["k1"], rowCount: 1, content: "x", expiresAt: future };
    await expect(exports_.create({ ...base, apiKeyId: "ghost", tokenHash: "t-a" })).rejects.toThrow();
    await expect(exports_.create({ ...base, contactIds: [], tokenHash: "t-b" })).rejects.toThrow();
    await expect(exports_.create({ ...base, rowCount: -1, tokenHash: "t-c" })).rejects.toThrow();
  });

  it("deletes only expired exports", async () => {
    const key = await apiKeys.create({ name: "e3", keyHash: "hash-e3", scopes: [] });
    const base = { apiKeyId: key.id, contactIds: ["k1"], rowCount: 1, content: "x" };
    await exports_.create({ ...base, tokenHash: "old", expiresAt: new Date(Date.now() - 1000) });
    await exports_.create({ ...base, tokenHash: "fresh", expiresAt: future });
    expect(await exports_.deleteExpired(new Date())).toBe(1);
    expect(await exports_.findByTokenHash("old")).toBeNull();
    expect(await exports_.findByTokenHash("fresh")).not.toBeNull();
  });
});
