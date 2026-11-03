import { COMPANY_SEARCH_MAX_LIMIT, CompanyDetailSchema, SearchCompaniesOutputSchema } from "@aip/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { CompanyService, CompanyRepository, ForbiddenError, NotFoundError, ValidationError } from "../src/index.js";
import { ALL_READ, caught, principal } from "./support/helpers.js";
import { createIsolatedDb, type IsolatedDb } from "./support/test-db.js";

let db: IsolatedDb;
let service: CompanyService;

const c = (id: string, name: string, industry: string, country: string, description: string, employees = 100) => ({
  id, name, website: `https://${id}.example`, industry, employees, country, description,
});

beforeAll(async () => {
  db = await createIsolatedDb(inject("templateDb"));
  const repo = new CompanyRepository(db.prisma);
  service = new CompanyService(repo);
  const fixtures = [
    c("c1", "Alpha Labs", "Artificial Intelligence", "Australia", "AI assistants for support teams.", 120),
    c("c2", "Beta Retail", "Retail", "Australia", "Inventory planning for retailers who maintain stock.", 80),
    c("c3", "Gamma Works", "Software", "New Zealand", "Cloud tools with AI-assisted code review.", 60),
    c("c4", "Delta Health", "Healthcare", "Australia", "Clinic scheduling software.", 300),
    c("c5", "Epsilon Inc", "Fintech", "United States", "A payments company serving lenders.", 45),
    c("c6", "Zeta Maintenance", "Manufacturing", "Canada", "Predictive maintenance sensors.", 900),
    c("c7", "Eta Commerce", "Software", "United Kingdom", "Platform for online retailers.", 30),
    c("t1", "Twin Co", "Logistics", "Ireland", "Duplicate name, first id."),
    c("t2", "Twin Co", "Logistics", "Ireland", "Duplicate name, second id."),
    ...Array.from({ length: 60 }, (_, i) => c(`b${String(i + 1).padStart(2, "0")}`, `Bulk ${String(i + 1).padStart(2, "0")}`, "Logistics", "Germany", "Generic widgets.")),
  ];
  for (const f of fixtures) await repo.create(f);
});
afterAll(() => db.drop());

const ids = async (input: unknown): Promise<string[]> => (await service.search(ALL_READ, input)).results.map((r) => r.id);

describe("CompanyService.search: matching", () => {
  it('"AI companies" finds the AI companies (filler word ignored), not substring look-alikes', async () => {
    expect(await ids({ query: "AI companies" })).toEqual(["c1", "c3"]);
  });

  it('"AI" matches whole tokens only: "retailers", "maintain", "maintenance" are excluded', async () => {
    expect(await ids({ query: "AI" })).toEqual(["c1", "c3"]);
  });

  it('"retail" matches the token, not "retailers"', async () => {
    expect(await ids({ query: "retail" })).toEqual(["c2"]);
    expect(await ids({ query: "retailers" })).toEqual(["c2", "c7"]);
    expect(await ids({ query: "retai" })).toEqual([]);
  });

  it("requires every term, which may be satisfied by different fields", async () => {
    expect(await ids({ query: "artificial support" })).toEqual(["c1"]); // industry + description
    expect(await ids({ query: "alpha artificial" })).toEqual(["c1"]); // name + industry
    expect(await ids({ query: "gamma ai" })).toEqual(["c3"]); // name + description
    expect(await ids({ query: "ai logistics" })).toEqual([]); // no company has both
    expect(await ids({ query: "software online" })).toEqual(["c7"]);
  });

  it("is case-insensitive", async () => {
    expect(await ids({ query: "aI COMPANIES" })).toEqual(["c1", "c3"]);
    expect(await ids({ query: "ARTIFICIAL intelligence" })).toEqual(["c1"]);
  });

  it("ignores punctuation and extra whitespace", async () => {
    expect(await ids({ query: "  AI,   companies!! " })).toEqual(["c1", "c3"]);
    expect(await ids({ query: "(AI)" })).toEqual(["c1", "c3"]);
    expect(await ids({ query: "ai-assisted" })).toEqual(["c3"]);
    expect(await ids({ query: "ai_assisted\tcode" })).toEqual(["c3"]);
  });

  it("drops filler words but still matches the real terms, even inside a company name", async () => {
    expect(await ids({ query: "company payments" })).toEqual(["c5"]);
    expect(await ids({ query: "epsilon inc" })).toEqual(["c5"]);
    expect(await ids({ query: "Epsilon Pty Ltd" })).toEqual(["c5"]);
  });

  it("returns a validation error when a non-empty query has only filler terms or punctuation", async () => {
    for (const query of ["companies", "inc", "Companies Inc Ltd Pty", "!!!"]) {
      const error = await caught(service.search(ALL_READ, { query }));
      expect(error, query).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("CompanyService.search: country, empty queries, ordering", () => {
  it("filters by country case-insensitively and exactly (trimmed)", async () => {
    expect(await ids({ country: "Australia" })).toEqual(["c1", "c2", "c4"]);
    expect(await ids({ country: "australia" })).toEqual(["c1", "c2", "c4"]);
    expect(await ids({ country: "  AUSTRALIA  " })).toEqual(["c1", "c2", "c4"]);
    expect(await ids({ country: "Austr" })).toEqual([]);
    expect(await ids({ country: "Australia Felix" })).toEqual([]);
  });

  it("combines a query with a country filter", async () => {
    expect(await ids({ query: "AI companies", country: "Australia" })).toEqual(["c1"]);
    expect(await ids({ query: "AI", country: "New Zealand" })).toEqual(["c3"]);
    expect(await ids({ query: "AI", country: "Canada" })).toEqual([]);
  });

  it("treats empty and whitespace-only query/country as not provided", async () => {
    expect(await ids({ query: "", country: "Canada" })).toEqual(["c6"]);
    expect(await ids({ query: "   ", country: "Canada" })).toEqual(["c6"]);
    expect(await ids({ country: "  ", query: "epsilon" })).toEqual(["c5"]);
    expect(await ids({})).toHaveLength(10); // no filters: first page by name
  });

  it("orders deterministically by name, then id", async () => {
    const first = await ids({ country: "Ireland" });
    expect(first).toEqual(["t1", "t2"]);
    expect(await ids({ country: "Ireland" })).toEqual(first);
    const page = await ids({});
    expect(page.slice(0, 2)).toEqual(["c1", "c2"]); // Alpha Labs, Beta Retail
    expect(await ids({})).toEqual(page);
  });
});

describe("CompanyService.search: limits and invalid input", () => {
  it("defaults to 10 results", async () => {
    expect(await ids({ query: "widgets" })).toHaveLength(10);
  });

  it("honours an explicit limit up to the maximum of 50", async () => {
    expect(await ids({ query: "widgets", limit: 1 })).toHaveLength(1);
    expect(await ids({ query: "widgets", limit: 25 })).toHaveLength(25);
    expect(await ids({ query: "widgets", limit: COMPANY_SEARCH_MAX_LIMIT })).toHaveLength(50);
  });

  it("rejects limits outside 1..50 in the service, whatever the transport", async () => {
    for (const limit of [0, -1, 51, 1000, 1.5, "10", null, Number.NaN]) {
      const error = await caught(service.search(ALL_READ, { query: "widgets", limit }));
      expect(error, String(limit)).toBeInstanceOf(ValidationError);
    }
  });

  it("applies the limit after whole-token matching (no false negatives from an early cut-off)", async () => {
    // Substring candidates for "ai" sort Alpha Labs (c1), Beta Retail (c2, false positive), ..., Gamma Works (c3).
    // A limit applied before whole-token filtering would take [c1, c2], drop c2, and return only [c1].
    expect(await ids({ query: "AI", limit: 2 })).toEqual(["c1", "c3"]);
    expect(await ids({ query: "AI", limit: 1 })).toEqual(["c1"]);
  });

  it("rejects invalid input shapes", async () => {
    for (const input of [undefined, null, "AI", 42, { query: 123 }, { query: "x".repeat(201) }, { country: ["Australia"] }]) {
      expect(await caught(service.search(ALL_READ, input)), JSON.stringify(input)).toBeInstanceOf(ValidationError);
    }
  });

  it("returns exactly the assignment's public shape", async () => {
    const out = await service.search(ALL_READ, { query: "AI", country: "Australia" });
    expect(SearchCompaniesOutputSchema.parse(out)).toEqual(out);
    expect(out).toEqual({ results: [{ id: "c1", name: "Alpha Labs", industry: "Artificial Intelligence", employees: 120 }] });
    expect(Object.keys(out.results[0] ?? {})).toEqual(["id", "name", "industry", "employees"]);
  });
});

describe("CompanyService.getById", () => {
  it("returns the public company shape", async () => {
    const company = await service.getById(ALL_READ, { companyId: "c1" });
    expect(CompanyDetailSchema.parse(company)).toEqual(company);
    expect(company).toEqual({
      id: "c1", name: "Alpha Labs", website: "https://c1.example", industry: "Artificial Intelligence",
      employees: 120, description: "AI assistants for support teams.", country: "Australia",
    });
    expect(company).not.toHaveProperty("createdAt");
  });

  it("returns NOT_FOUND for an unknown id and VALIDATION_ERROR for a blank one", async () => {
    const missing = await caught(service.getById(ALL_READ, { companyId: "cmp_999" }));
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((missing as NotFoundError).code).toBe("NOT_FOUND");
    expect(await caught(service.getById(ALL_READ, { companyId: "" }))).toBeInstanceOf(ValidationError);
    expect(await caught(service.getById(ALL_READ, {}))).toBeInstanceOf(ValidationError);
  });
});

describe("CompanyService scope enforcement", () => {
  it("requires companies:read for both operations, before validating input", async () => {
    const wrong = principal("contacts:read", "contacts:enrich", "contacts:export");
    for (const run of [
      () => service.search(wrong, { query: "AI" }),
      () => service.search(wrong, { limit: 9999 }),
      () => service.getById(wrong, { companyId: "c1" }),
    ]) {
      const error = await caught(run());
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).message).toContain("companies:read");
    }
    expect(await caught(service.search(principal(), {}))).toBeInstanceOf(ForbiddenError);
  });
});
