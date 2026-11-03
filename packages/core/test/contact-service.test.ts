import { CONTACT_SEARCH_MAX_RESULTS, SearchContactsOutputSchema } from "@aip/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { CompanyRepository, ContactRepository, ContactService, ForbiddenError, NotFoundError, seedDatabase, ValidationError } from "../src/index.js";
import { ALL_READ, caught, principal } from "./support/helpers.js";
import { createIsolatedDb, type IsolatedDb } from "./support/test-db.js";

let db: IsolatedDb;
let service: ContactService;

beforeAll(async () => {
  db = await createIsolatedDb(inject("templateDb"));
  await seedDatabase(db.prisma);
  service = new ContactService(new ContactRepository(db.prisma), new CompanyRepository(db.prisma));
});
afterAll(() => db.drop());

describe("ContactService.search: filtering", () => {
  it("returns a company's contacts with the assignment's public field names", async () => {
    const out = await service.search(ALL_READ, { companyId: "cmp_1" });
    expect(out.contacts).toHaveLength(4);
    expect(SearchContactsOutputSchema.parse(out)).toEqual(out);
    for (const contact of out.contacts) expect(Object.keys(contact)).toEqual(["id", "name", "title"]);

    const rows = await db.prisma.contact.findMany({ where: { companyId: "cmp_1" } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(out.contacts.map((c) => c.id).sort()).toEqual([...byId.keys()].sort());
    for (const c of out.contacts) {
      expect(c.name).toBe(byId.get(c.id)?.fullName); // fullName -> name
      expect(c.title).toBe(byId.get(c.id)?.jobTitle); // jobTitle -> title
    }
  });

  it("does not leak internal or personal fields", async () => {
    const json = JSON.stringify(await service.search(ALL_READ, { companyId: "cmp_1" }));
    for (const forbidden of ["fullName", "jobTitle", "firstName", "lastName", "email", "linkedin", "companyId", "createdAt"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("matches job titles case-insensitively (substring, as in the assignment's 'Engineer' example)", async () => {
    const expected = await db.prisma.contact.count({ where: { jobTitle: { contains: "engineer", mode: "insensitive" } } });
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThanOrEqual(CONTACT_SEARCH_MAX_RESULTS);
    for (const jobTitle of ["engineer", "ENGINEER", "EnGiNeEr", "  engineer  "]) {
      const out = await service.search(ALL_READ, { jobTitle });
      expect(out.contacts, jobTitle).toHaveLength(expected);
      expect(out.contacts.every((c) => c.title.toLowerCase().includes("engineer"))).toBe(true);
    }
    expect((await service.search(ALL_READ, { jobTitle: "senior engineer" })).contacts.every((c) => c.title === "Senior Engineer")).toBe(true);
  });

  it("combines companyId and jobTitle", async () => {
    const out = await service.search(ALL_READ, { companyId: "cmp_1", jobTitle: "CHIEF" });
    expect(out.contacts.length).toBeGreaterThan(0);
    expect(out.contacts.every((c) => c.title.toLowerCase().includes("chief"))).toBe(true);
    const all = await service.search(ALL_READ, { companyId: "cmp_1" });
    expect(out.contacts.length).toBeLessThan(all.contacts.length);
  });

  it("returns an empty list (not an error) when the company exists but nothing matches", async () => {
    expect(await service.search(ALL_READ, { companyId: "cmp_1", jobTitle: "astronaut" })).toEqual({ contacts: [] });
  });

  it("orders deterministically", async () => {
    const a = await service.search(ALL_READ, { jobTitle: "manager" });
    const b = await service.search(ALL_READ, { jobTitle: "manager" });
    expect(a).toEqual(b);
    const names = a.contacts.map((c) => c.name);
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y, "en")));
  });
});

describe("ContactService.search: validation and errors", () => {
  it("returns NOT_FOUND when the supplied companyId does not exist, with or without a title", async () => {
    for (const input of [{ companyId: "cmp_999" }, { companyId: "cmp_999", jobTitle: "engineer" }]) {
      const error = await caught(service.search(ALL_READ, input));
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).message).toBe("Company not found: cmp_999");
    }
  });

  it("requires at least one filter; blank strings do not count", async () => {
    for (const input of [{}, { companyId: "" }, { jobTitle: "   " }, { companyId: " ", jobTitle: "" }]) {
      expect(await caught(service.search(ALL_READ, input)), JSON.stringify(input)).toBeInstanceOf(ValidationError);
    }
  });

  it("a blank companyId is ignored when a jobTitle is supplied", async () => {
    const out = await service.search(ALL_READ, { companyId: "", jobTitle: "engineer" });
    expect(out.contacts.length).toBeGreaterThan(0);
  });

  it("rejects invalid input shapes", async () => {
    for (const input of [undefined, null, "cmp_1", { companyId: 1 }, { jobTitle: ["x"] }, { jobTitle: "x".repeat(101) }]) {
      expect(await caught(service.search(ALL_READ, input)), JSON.stringify(input)).toBeInstanceOf(ValidationError);
    }
  });

  it("caps results at 100", async () => {
    const matching = await db.prisma.contact.count({ where: { jobTitle: { contains: "e", mode: "insensitive" } } });
    expect(matching).toBeGreaterThan(CONTACT_SEARCH_MAX_RESULTS); // precondition: the cap actually bites
    const out = await service.search(ALL_READ, { jobTitle: "e" });
    expect(out.contacts).toHaveLength(CONTACT_SEARCH_MAX_RESULTS);
    expect(await service.search(ALL_READ, { jobTitle: "e" })).toEqual(out); // same 100 every time
  });
});

describe("ContactService scope enforcement", () => {
  it("requires contacts:read, before validating input or touching the database", async () => {
    for (const wrong of [principal("companies:read"), principal("contacts:enrich", "contacts:export"), principal()]) {
      for (const input of [{ companyId: "cmp_1" }, {}, undefined]) {
        const error = await caught(service.search(wrong, input));
        expect(error).toBeInstanceOf(ForbiddenError);
        expect((error as ForbiddenError).message).toContain("contacts:read");
      }
    }
  });
});
