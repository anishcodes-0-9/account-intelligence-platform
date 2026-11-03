import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedDatabase } from "../src/seed/seed.js";
import { createIsolatedDb, type IsolatedDb } from "./support/test-db.js";

let db: IsolatedDb;
beforeAll(async () => {
  db = await createIsolatedDb(inject("templateDb"));
});
afterAll(() => db.drop());

const snapshot = async (): Promise<string> => {
  const companies = await db.prisma.company.findMany({ orderBy: { id: "asc" } });
  const contacts = await db.prisma.contact.findMany({ orderBy: { id: "asc" } });
  const strip = ({ createdAt: _c, updatedAt: _u, ...rest }: { createdAt: Date; updatedAt: Date }) => rest;
  return JSON.stringify({ companies: companies.map(strip), contacts: contacts.map(strip) });
};

describe("seed", () => {
  it("meets the assignment minimums with deterministic ids", async () => {
    const result = await seedDatabase(db.prisma);
    expect(result).toEqual({ companies: 60, contacts: 240 });
    expect(result.companies).toBeGreaterThanOrEqual(50);
    expect(result.contacts).toBeGreaterThanOrEqual(200);
    expect(await db.prisma.company.findUnique({ where: { id: "cmp_1" } })).not.toBeNull();
    expect(await db.prisma.company.findUnique({ where: { id: "cmp_60" } })).not.toBeNull();
    expect(await db.prisma.contact.findUnique({ where: { id: "cnt_1" } })).not.toBeNull();
    expect(await db.prisma.contact.findUnique({ where: { id: "cnt_240" } })).not.toBeNull();
  });

  it("is idempotent: a second run leaves counts and contents unchanged", async () => {
    const before = await snapshot();
    const result = await seedDatabase(db.prisma);
    expect(result).toEqual({ companies: 60, contacts: 240 });
    expect(await snapshot()).toBe(before);
  });

  it("gives every contact a company and keeps data varied and synthetic", async () => {
    const [companies, contacts] = await Promise.all([db.prisma.company.findMany(), db.prisma.contact.findMany()]);
    const companyIds = new Set(companies.map((c) => c.id));
    expect(contacts.every((c) => companyIds.has(c.companyId))).toBe(true);
    expect(new Set(contacts.map((c) => c.companyId)).size).toBe(60);
    expect(new Set(companies.map((c) => c.name)).size).toBe(60);
    expect(new Set(contacts.map((c) => c.fullName)).size).toBe(240);
    expect(new Set(companies.map((c) => c.industry)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(companies.map((c) => c.country)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(contacts.map((c) => c.jobTitle)).size).toBeGreaterThanOrEqual(15);
    expect(companies.every((c) => c.website.endsWith(".example"))).toBe(true);
    expect(contacts.every((c) => c.email === null && c.linkedin === null)).toBe(true);
  });

  it("includes AI companies (incl. in Australia), engineers and mid-size companies for realistic searches", async () => {
    const ai = await db.prisma.company.findMany({ where: { industry: "Artificial Intelligence" } });
    expect(ai.length).toBeGreaterThanOrEqual(10);
    expect(ai.filter((c) => c.country === "Australia").length).toBeGreaterThanOrEqual(3);
    expect(ai.every((c) => /\bAI\b/.test(c.description))).toBe(true);
    expect(await db.prisma.contact.count({ where: { jobTitle: { contains: "engineer", mode: "insensitive" } } })).toBeGreaterThan(10);
    expect(await db.prisma.contact.count({ where: { jobTitle: "Senior Engineer" } })).toBeGreaterThan(0);
    expect(await db.prisma.company.count({ where: { employees: { gte: 50, lte: 500 } } })).toBeGreaterThan(10);
  });

  it("re-seeding does not wipe enrichment results or other tables", async () => {
    await db.prisma.contact.update({ where: { id: "cnt_1" }, data: { email: "x@example.com", linkedin: "https://example.com/in/x" } });
    await db.prisma.enrichmentRecord.create({
      data: { contactId: "cnt_1", provider: "mock", status: "SUCCESS", returned: {}, provenance: {} },
    });
    await seedDatabase(db.prisma);
    const contact = await db.prisma.contact.findUniqueOrThrow({ where: { id: "cnt_1" } });
    expect(contact.email).toBe("x@example.com");
    expect(contact.linkedin).toBe("https://example.com/in/x");
    expect(await db.prisma.enrichmentRecord.count()).toBe(1);
  });
});
