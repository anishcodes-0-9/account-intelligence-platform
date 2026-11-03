import { EnrichContactOutputSchema } from "@aip/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ContactRepository,
  createLogger,
  EnrichmentRepository,
  EnrichmentService,
  ForbiddenError,
  mapError,
  MockEnrichmentProvider,
  mockOutcomeFor,
  NotFoundError,
  ProviderError,
  seedDatabase,
  ValidationError,
  type EnrichmentProvider,
  type ProviderResult,
} from "../src/index.js";
import { ALL_READ, captureLogs, caught, principal } from "./support/helpers.js";
import { createIsolatedDb, type IsolatedDb } from "./support/test-db.js";

let db: IsolatedDb;
let contacts: ContactRepository;
let enrichments: EnrichmentRepository;

const ids = Array.from({ length: 240 }, (_, i) => `cnt_${i + 1}`);
const idFor = (outcome: string): string => ids.find((id) => mockOutcomeFor(id) === outcome)!;
const fixedNow = () => new Date("2026-01-02T03:04:05.000Z");

/** A provider whose result (or failure) the test controls. */
function stub(result: ProviderResult | Error, synthetic = true): EnrichmentProvider & { calls: number } {
  const provider = {
    name: "stub",
    synthetic,
    calls: 0,
    async enrich() {
      provider.calls++;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return provider;
}

const service = (provider: EnrichmentProvider, extra = {}) => new EnrichmentService(db.prisma, provider, { now: fixedNow, ...extra });

beforeAll(async () => {
  db = await createIsolatedDb(inject("templateDb"));
  await seedDatabase(db.prisma);
  contacts = new ContactRepository(db.prisma);
  enrichments = new EnrichmentRepository(db.prisma);
});
afterAll(() => db.drop());

describe("mock provider fixtures", () => {
  it("are deterministic and cover every outcome", () => {
    expect(ids.map(mockOutcomeFor)).toEqual(ids.map(mockOutcomeFor));
    for (const outcome of ["SUCCESS", "PARTIAL", "NOT_FOUND", "FAILED"]) expect(idFor(outcome)).toBeDefined();
  });

  it("only produce reserved example domains and obviously synthetic LinkedIn handles", async () => {
    const provider = new MockEnrichmentProvider();
    for (const id of ids.filter((i) => ["SUCCESS", "PARTIAL"].includes(mockOutcomeFor(i)))) {
      const contact = (await contacts.findById(id))!;
      const { email, linkedin } = await provider.enrich(contact);
      expect(email).toMatch(/^[a-z0-9.]+@[a-z0-9]+\.example$/);
      if (linkedin) expect(linkedin).toMatch(/^https:\/\/linkedin\.example\/in\/synthetic-/);
    }
  });
});

describe("EnrichmentService.enrich", () => {
  it("SUCCESS: returns both fields, records the attempt and updates the contact", async () => {
    const id = idFor("SUCCESS");
    const out = await service(new MockEnrichmentProvider()).enrich(ALL_READ, { contactId: id });
    expect(EnrichContactOutputSchema.parse(out)).toEqual(out);
    expect(out.status).toBe("SUCCESS");
    expect(out.provider).toBe("mock-synthetic");
    expect(out.email).toMatch(/@.*\.example$/);
    expect(out.linkedin).toContain("synthetic-");

    const contact = (await contacts.findById(id))!;
    expect([contact.email, contact.linkedin]).toEqual([out.email, out.linkedin]);
    const [record] = await enrichments.listForContact(id);
    expect(record).toMatchObject({ status: "SUCCESS", provider: "mock-synthetic", error: null, returned: { email: out.email, linkedin: out.linkedin } });
  });

  it("records provenance marked synthetic and unverified for every returned field", async () => {
    const out = await service(stub({ email: "a@x.example", linkedin: "https://l.example/in/a" })).enrich(ALL_READ, { contactId: "cnt_5" });
    const expected = [
      { field: "email", source: "stub", synthetic: true, verified: false, observedAt: "2026-01-02T03:04:05.000Z" },
      { field: "linkedin", source: "stub", synthetic: true, verified: false, observedAt: "2026-01-02T03:04:05.000Z" },
    ];
    expect(out.provenance).toEqual(expected);
    expect((await enrichments.listForContact("cnt_5"))[0]?.provenance).toEqual(expected);
  });

  it("never marks anything verified, even if a provider is not synthetic", async () => {
    const out = await service(stub({ email: "a@x.example", linkedin: null }, false)).enrich(ALL_READ, { contactId: "cnt_6" });
    expect(out.provenance).toEqual([expect.objectContaining({ field: "email", synthetic: false, verified: false })]);
  });

  it("PARTIAL: only the returned field is reported and written, and an earlier value is kept", async () => {
    await service(stub({ email: "old@x.example", linkedin: "https://l.example/in/old" })).enrich(ALL_READ, { contactId: "cnt_7" });
    const out = await service(stub({ email: "new@x.example", linkedin: null })).enrich(ALL_READ, { contactId: "cnt_7" });
    expect(out).toMatchObject({ status: "PARTIAL", email: "new@x.example", linkedin: null });
    expect(out.provenance.map((p) => p.field)).toEqual(["email"]);
    const contact = (await contacts.findById("cnt_7"))!;
    expect([contact.email, contact.linkedin]).toEqual(["new@x.example", "https://l.example/in/old"]);
  });

  it("PARTIAL via the mock provider (email only)", async () => {
    const id = idFor("PARTIAL");
    const out = await service(new MockEnrichmentProvider()).enrich(ALL_READ, { contactId: id });
    expect(out).toMatchObject({ status: "PARTIAL", linkedin: null });
    expect(out.email).not.toBeNull();
  });

  it("NOT_FOUND: nothing is written to the contact but the attempt is recorded", async () => {
    await service(stub({ email: "keep@x.example", linkedin: null })).enrich(ALL_READ, { contactId: "cnt_8" });
    const out = await service(stub({ email: null, linkedin: null })).enrich(ALL_READ, { contactId: "cnt_8" });
    expect(out).toEqual({ email: null, linkedin: null, status: "NOT_FOUND", provider: "stub", provenance: [] });
    expect((await contacts.findById("cnt_8"))?.email).toBe("keep@x.example");
    const before = (await contacts.findById("cnt_8"))!.updatedAt;
    await service(stub({ email: null, linkedin: null })).enrich(ALL_READ, { contactId: "cnt_8" });
    expect((await contacts.findById("cnt_8"))!.updatedAt).toEqual(before); // no write at all
    expect((await enrichments.listForContact("cnt_8"))[0]?.status).toBe("NOT_FOUND");
  });

  it("treats empty strings from a provider as not found", async () => {
    const out = await service(stub({ email: "", linkedin: "" })).enrich(ALL_READ, { contactId: "cnt_9" });
    expect(out.status).toBe("NOT_FOUND");
    expect((await contacts.findById("cnt_9"))?.email).toBeNull();
  });

  it("FAILED: throws PROVIDER_ERROR, records a FAILED attempt and leaves the contact untouched", async () => {
    await service(stub({ email: "keep@x.example", linkedin: "https://l.example/in/keep" })).enrich(ALL_READ, { contactId: "cnt_10" });
    const logs = captureLogs();
    const failing = service(stub(new Error("upstream 503 at https://api.vendor.example?key=sekret")), { logger: createLogger({ destination: logs.destination }) });
    const error = await caught(failing.enrich(ALL_READ, { contactId: "cnt_10" }));
    expect(error).toBeInstanceOf(ProviderError);
    expect(mapError(error, createLogger({ destination: captureLogs().destination })).body.error).toEqual({ code: "PROVIDER_ERROR", message: "Enrichment provider failed" });

    const contact = (await contacts.findById("cnt_10"))!;
    expect([contact.email, contact.linkedin]).toEqual(["keep@x.example", "https://l.example/in/keep"]);
    const [record] = await enrichments.listForContact("cnt_10");
    expect(record).toMatchObject({ status: "FAILED", provenance: [], returned: {} });
    expect(record?.error).toContain("upstream 503");
    expect(record?.error).not.toContain("sekret");
    expect(logs.text()).not.toContain("sekret");
    expect(logs.lines()[0]).toMatchObject({ contactId: "cnt_10", status: "FAILED" });
  });

  describe("provider error sanitization", () => {
    it.each([
      ["aip_ key leaks in the message", "upstream rejected key aip_clx1y2z3_abcdefghijklmnopqrstuvwxyz", "aip_clx1y2z3_abcdefghijklmnopqrstuvwxyz"],
      ["a Bearer token", "request failed: Bearer eyJhbGciOiJIUzI1NiJ9.sekret.payload", "eyJhbGciOiJIUzI1NiJ9.sekret.payload"],
      ["an Authorization header", "upstream 401, sent Authorization: Bearer sekret-header-value", "sekret-header-value"],
      ["a password assignment", "connection refused, password=S3kretPass!", "S3kretPass!"],
      ["an api key query param", "GET https://vendor.example/lookup?apiKey=sekret-query-value failed", "sekret-query-value"],
      ["a secret: value header style", "config error, secret: sekret-colon-value", "sekret-colon-value"],
    ])("redacts %s before persistence and never logs the raw message", async (_label, message, secret) => {
      const logs = captureLogs();
      const failing = service(stub(new Error(message)), { logger: createLogger({ destination: logs.destination }) });
      await caught(failing.enrich(ALL_READ, { contactId: "cnt_10" }));
      const [record] = await enrichments.listForContact("cnt_10");
      expect(record?.error).not.toContain(secret);
      expect(logs.text()).not.toContain(secret);
    });

    it("truncates an unexpectedly long provider error to the stored maximum", async () => {
      const failing = service(stub(new Error("x".repeat(5000))));
      await caught(failing.enrich(ALL_READ, { contactId: "cnt_10" }));
      const [record] = await enrichments.listForContact("cnt_10");
      expect(record?.error).toHaveLength(300);
    });

    it("never stores a stack trace", async () => {
      const error = new Error("boom with a stack");
      const failing = service(stub(error));
      await caught(failing.enrich(ALL_READ, { contactId: "cnt_10" }));
      const [record] = await enrichments.listForContact("cnt_10");
      expect(record?.error).not.toContain("at ");
      expect(record?.error).not.toContain(".ts:");
    });

    it("still reports PROVIDER_ERROR to the caller; sanitization never turns a failure into a success", async () => {
      const error = await caught(service(stub(new Error("password=whatever"))).enrich(ALL_READ, { contactId: "cnt_10" }));
      expect(error).toBeInstanceOf(ProviderError);
    });
  });

  it("FAILED via the mock provider", async () => {
    const error = await caught(service(new MockEnrichmentProvider()).enrich(ALL_READ, { contactId: idFor("FAILED") }));
    expect(error).toBeInstanceOf(ProviderError);
  });

  it("creates a new record on every call, including repeats", async () => {
    const provider = stub({ email: "r@x.example", linkedin: null });
    const svc = service(provider);
    for (let i = 0; i < 3; i++) await svc.enrich(ALL_READ, { contactId: "cnt_11" });
    expect(provider.calls).toBe(3);
    const records = await enrichments.listForContact("cnt_11");
    expect(records).toHaveLength(3);
    expect(new Set(records.map((r) => r.id)).size).toBe(3);
  });

  it("keeps the latest successful value after a later failure and a later success", async () => {
    await service(stub({ email: "first@x.example", linkedin: null })).enrich(ALL_READ, { contactId: "cnt_12" });
    await caught(service(stub(new Error("boom"))).enrich(ALL_READ, { contactId: "cnt_12" }));
    expect((await contacts.findById("cnt_12"))?.email).toBe("first@x.example");
    await service(stub({ email: "second@x.example", linkedin: null })).enrich(ALL_READ, { contactId: "cnt_12" });
    expect((await contacts.findById("cnt_12"))?.email).toBe("second@x.example");
  });

  it("unknown contact: NOT_FOUND, provider is not called, nothing is recorded", async () => {
    const provider = stub({ email: "a@x.example", linkedin: null });
    const error = await caught(service(provider).enrich(ALL_READ, { contactId: "cnt_nope" }));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(provider.calls).toBe(0);
    expect(await db.prisma.enrichmentRecord.count({ where: { contactId: "cnt_nope" } })).toBe(0);
  });

  it.each([{}, { contactId: "" }, { contactId: 5 }, null, "cnt_1"])("rejects invalid input %j", async (input) => {
    expect(await caught(service(stub({ email: null, linkedin: null })).enrich(ALL_READ, input))).toBeInstanceOf(ValidationError);
  });
});

describe("enrichment write atomicity", () => {
  it("SUCCESS: the enrichment record and the contact update land together", async () => {
    const out = await service(stub({ email: "atomic@x.example", linkedin: "https://l.example/in/atomic" })).enrich(ALL_READ, { contactId: "cnt_15" });
    const contact = (await contacts.findById("cnt_15"))!;
    const [record] = await enrichments.listForContact("cnt_15");
    expect([contact.email, contact.linkedin]).toEqual([out.email, out.linkedin]);
    expect(record).toMatchObject({ status: "SUCCESS" });
  });

  it("PARTIAL: the enrichment record and the contact update land together", async () => {
    const out = await service(stub({ email: "partial-atomic@x.example", linkedin: null })).enrich(ALL_READ, { contactId: "cnt_16" });
    const contact = (await contacts.findById("cnt_16"))!;
    const [record] = await enrichments.listForContact("cnt_16");
    expect(contact.email).toBe(out.email);
    expect(record).toMatchObject({ status: "PARTIAL" });
  });

  describe("rollback through EnrichmentService itself", () => {
    const TARGET_ID = "cnt_17";
    const TRIGGER_FN = "test_fail_contact_update_cnt_17";
    const TRIGGER_NAME = "test_fail_contact_update_cnt_17_trigger";

    /**
     * A BEFORE UPDATE trigger on `contacts`, scoped to one row (TARGET_ID) by an `IF` inside the
     * function body, so it cannot affect any other contact or any other test file (each gets its own
     * cloned database from createIsolatedDb, so there is no cross-file contention either way).
     */
    async function installFailingUpdateTrigger(): Promise<void> {
      await db.prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION ${TRIGGER_FN}() RETURNS trigger AS $$
        BEGIN
          IF NEW.id = '${TARGET_ID}' THEN
            RAISE EXCEPTION 'test: forced contact update failure for %', NEW.id;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await db.prisma.$executeRawUnsafe(`
        CREATE TRIGGER ${TRIGGER_NAME}
        BEFORE UPDATE ON contacts
        FOR EACH ROW
        EXECUTE FUNCTION ${TRIGGER_FN}();
      `);
    }

    async function dropFailingUpdateTrigger(): Promise<void> {
      await db.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON contacts;`);
      await db.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${TRIGGER_FN}();`);
    }

    it("rolls back the enrichment record when EnrichmentService.enrich's own contact update fails", async () => {
      const beforeContact = (await contacts.findById(TARGET_ID))!;
      const beforeCount = await db.prisma.enrichmentRecord.count({ where: { contactId: TARGET_ID } });
      expect(beforeContact.email).toBeNull();
      expect(beforeContact.linkedin).toBeNull();

      await installFailingUpdateTrigger();
      try {
        // Calls the real EnrichmentService.enrich path: it creates the EnrichmentRecord and updates the
        // contact inside its own $transaction; the trigger fires on that update and forces it to fail.
        const error = await caught(
          service(stub({ email: "should-not-persist@x.example", linkedin: "https://l.example/in/should-not-persist" })).enrich(ALL_READ, {
            contactId: TARGET_ID,
          }),
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("forced contact update failure");
      } finally {
        await dropFailingUpdateTrigger();
      }

      // No partial state: the EnrichmentRecord created inside the same transaction was rolled back too.
      expect(await db.prisma.enrichmentRecord.count({ where: { contactId: TARGET_ID } })).toBe(beforeCount);
      const afterContact = await contacts.findById(TARGET_ID);
      expect(afterContact?.email).toBe(beforeContact.email);
      expect(afterContact?.linkedin).toBe(beforeContact.linkedin);
    });
  });
});

describe("enrichment authorization and logging", () => {
  it("requires contacts:enrich, checked before anything runs", async () => {
    const provider = stub({ email: "a@x.example", linkedin: null });
    for (const p of [principal(), principal("contacts:read", "contacts:export", "companies:read")]) {
      const error = await caught(service(provider).enrich(p, { contactId: "cnt_13" }));
      expect(error).toBeInstanceOf(ForbiddenError);
    }
    expect(provider.calls).toBe(0);
    expect(await db.prisma.enrichmentRecord.count({ where: { contactId: "cnt_13" } })).toBe(0);
    await expect(service(provider).enrich(principal("contacts:enrich"), { contactId: "cnt_13" })).resolves.toBeDefined();
  });

  it("logs contact ids and status but never the enriched email or LinkedIn", async () => {
    const logs = captureLogs();
    await service(stub({ email: "private.person@x.example", linkedin: "https://l.example/in/private-person" }), {
      logger: createLogger({ destination: logs.destination }),
    }).enrich(ALL_READ, { contactId: "cnt_14" });
    expect(logs.lines()[0]).toMatchObject({ contactId: "cnt_14", status: "SUCCESS", keyId: "test-key" });
    expect(logs.text()).not.toContain("private.person");
    expect(logs.text()).not.toContain("private-person");
  });
});
