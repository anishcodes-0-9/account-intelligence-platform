import { createHash } from "node:crypto";
import { EXPORT_MAX_CONTACTS, ExportContactsOutputSchema } from "@aip/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ApiKeyRepository,
  ContactRepository,
  createLogger,
  ExportLimitError,
  ExportRepository,
  ExportService,
  EXPORT_TTL_MS,
  ForbiddenError,
  NotFoundError,
  seedDatabase,
  ValidationError,
  type AuthPrincipal,
} from "../src/index.js";
import { captureLogs, caught } from "./support/helpers.js";
import { createIsolatedDb, type IsolatedDb } from "./support/test-db.js";

const BASE = "http://127.0.0.1:3001";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const tokenOf = (url: string) => url.slice(`${BASE}/downloads/`.length);

let db: IsolatedDb;
let contacts: ContactRepository;
let exports_: ExportRepository;
let admin: AuthPrincipal;
let clock = new Date("2026-01-01T00:00:00.000Z");
const tick = (ms: number) => (clock = new Date(clock.getTime() + ms));

const service = (logger?: ReturnType<typeof createLogger>) =>
  new ExportService(contacts, exports_, { downloadBaseUrl: BASE, now: () => clock, ...(logger ? { logger } : {}) });
const svc = () => service();

beforeAll(async () => {
  db = await createIsolatedDb(inject("templateDb"));
  await seedDatabase(db.prisma);
  contacts = new ContactRepository(db.prisma);
  exports_ = new ExportRepository(db.prisma);
  // ExportJob.apiKeyId is a foreign key, so the principal must be a real key.
  const key = await new ApiKeyRepository(db.prisma).create({ name: "exporter", keyHash: "0".repeat(64), scopes: ["contacts:export"] });
  admin = { keyId: key.id, name: "exporter", scopes: ["contacts:export"] };
});
afterAll(() => db.drop());

describe("ExportService.export", () => {
  it("exports valid contacts as CSV with the public columns, in request order", async () => {
    await contacts.updateEnrichedFields("cnt_2", { email: "two@x.example", linkedin: "https://l.example/in/two" });
    const out = await svc().export(admin, { contactIds: ["cnt_2", "cnt_1"] });
    expect(ExportContactsOutputSchema.parse(out)).toEqual(out);
    expect(out.rowCount).toBe(2);
    expect(out.downloadUrl).toMatch(new RegExp(`^${BASE}/downloads/[A-Za-z0-9_-]{43}$`));
    expect(EXPORT_TTL_MS).toBe(15 * 60 * 1000); // literal on purpose: the 15-minute rule must not change silently
    expect(out.expiresAt).toBe(new Date(clock.getTime() + 900_000).toISOString());

    const { content } = await svc().download(tokenOf(out.downloadUrl));
    const [header, first, second, trailing] = content.split("\r\n");
    expect(header).toBe("id,name,title,email,linkedin");
    expect(first).toMatch(/^cnt_2,.+,two@x\.example,https:\/\/l\.example\/in\/two$/);
    expect(second).toMatch(/^cnt_1,[^,]+,[^,]+,,$/);
    expect(trailing).toBe("");
  });

  it("does not expose internal database fields", async () => {
    const out = await svc().export(admin, { contactIds: ["cnt_3"] });
    const { content } = await svc().download(tokenOf(out.downloadUrl));
    expect(content.split("\r\n")[0]).toBe("id,name,title,email,linkedin");
    for (const internal of ["cmp_", "companyId", "createdAt", "updatedAt", "firstName", "fullName", "jobTitle"]) expect(content).not.toContain(internal);
  });

  it("escapes commas, quotes and newlines and neutralizes formulas in stored values", async () => {
    await db.prisma.contact.update({ where: { id: "cnt_4" }, data: { fullName: '=HYPERLINK("x"),\nQ', jobTitle: "VP, \"Ops\"", email: "+1@x.example" } });
    const out = await svc().export(admin, { contactIds: ["cnt_4"] });
    const { content } = await svc().download(tokenOf(out.downloadUrl));
    expect(content).toContain(`cnt_4,"'=HYPERLINK(""x""),\nQ","VP, ""Ops""",'+1@x.example,`);
  });

  it("collapses duplicate ids", async () => {
    const out = await svc().export(admin, { contactIds: ["cnt_1", "cnt_1", "cnt_2"] });
    expect(out.rowCount).toBe(2);
    expect((await db.prisma.exportJob.findUniqueOrThrow({ where: { id: out.exportId } })).contactIds).toEqual(["cnt_1", "cnt_2"]);
  });

  it("fails the entire export, naming every missing id, and stores nothing", async () => {
    const before = await db.prisma.exportJob.count();
    const error = await caught(svc().export(admin, { contactIds: ["cnt_1", "cnt_missing_a", "cnt_2", "cnt_missing_b"] }));
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe("Contacts not found: cnt_missing_a, cnt_missing_b");
    expect(await db.prisma.exportJob.count()).toBe(before);
  });

  it("allows exactly the maximum and rejects one more with EXPORT_LIMIT", async () => {
    const all = (await db.prisma.contact.findMany({ select: { id: true }, orderBy: { id: "asc" }, take: EXPORT_MAX_CONTACTS + 1 })).map((c) => c.id);
    expect((await svc().export(admin, { contactIds: all.slice(0, EXPORT_MAX_CONTACTS) })).rowCount).toBe(EXPORT_MAX_CONTACTS);
    const before = await db.prisma.exportJob.count();
    const error = await caught(svc().export(admin, { contactIds: all }));
    expect(error).toBeInstanceOf(ExportLimitError);
    expect(await db.prisma.exportJob.count()).toBe(before);
  });

  it.each([{}, { contactIds: [] }, { contactIds: "cnt_1" }, { contactIds: [""] }, { contactIds: [1] }, null])("rejects invalid input %j", async (input) => {
    expect(await caught(svc().export(admin, input))).toBeInstanceOf(ValidationError);
  });

  describe("export payload boundaries", () => {
    const idsOf = (n: number) => Array.from({ length: n }, (_, i) => `cnt_${i + 1}`);

    it("200 ids: accepted for processing", async () => {
      expect((await svc().export(admin, { contactIds: idsOf(200) })).rowCount).toBe(200);
    });

    it("201 ids: EXPORT_LIMIT from the service, not a schema VALIDATION_ERROR", async () => {
      const error = await caught(svc().export(admin, { contactIds: idsOf(201) }));
      expect(error).toBeInstanceOf(ExportLimitError);
    });

    it("1001 ids: VALIDATION_ERROR from the schema, before the service's own limit is ever reached", async () => {
      const error = await caught(svc().export(admin, { contactIds: idsOf(1001) }));
      expect(error).toBeInstanceOf(ValidationError);
    });

    it("1000 ids: passes schema validation and is then rejected by the service's EXPORT_LIMIT", async () => {
      const error = await caught(svc().export(admin, { contactIds: idsOf(1000) }));
      expect(error).toBeInstanceOf(ExportLimitError);
    });
  });
});

describe("download token", () => {
  it("stores only the SHA-256 of a 32-byte random token", async () => {
    const out = await svc().export(admin, { contactIds: ["cnt_1"] });
    const token = tokenOf(out.downloadUrl);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const job = await db.prisma.exportJob.findUniqueOrThrow({ where: { id: out.exportId } });
    expect(job.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(job)).not.toContain(token);
    expect(job.apiKeyId).toBe(admin.keyId);
  });

  it("generates a different token for every export", async () => {
    const urls = await Promise.all([1, 2, 3].map(() => svc().export(admin, { contactIds: ["cnt_1"] }).then((o) => o.downloadUrl)));
    expect(new Set(urls).size).toBe(3);
  });

  it("serves content until exactly 15 minutes after creation, then behaves as unknown", async () => {
    const out = await svc().export(admin, { contactIds: ["cnt_1"] });
    const token = tokenOf(out.downloadUrl);
    tick(EXPORT_TTL_MS - 1);
    await expect(svc().download(token)).resolves.toMatchObject({ rowCount: 1 });
    tick(1);
    const expired = await caught(svc().download(token));
    const unknown = await caught(svc().download("A".repeat(43)));
    expect(expired).toBeInstanceOf(NotFoundError);
    expect({ code: (expired as NotFoundError).code, message: (expired as Error).message }).toEqual({ code: "NOT_FOUND", message: (unknown as Error).message });
  });

  it("gives the same NOT_FOUND for unknown, malformed and tampered tokens", async () => {
    const out = await svc().export(admin, { contactIds: ["cnt_1"] });
    const token = tokenOf(out.downloadUrl);
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const messages = new Set<string>();
    for (const bad of ["", "short", "A".repeat(43), tampered, `${token}x`, token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase(), "../etc/passwd", sha256(token)]) {
      const error = await caught(svc().download(bad));
      expect(error).toBeInstanceOf(NotFoundError);
      messages.add((error as Error).message);
    }
    expect(messages.size).toBe(1);
  });

  it("does not look up the database for malformed tokens", async () => {
    let lookups = 0;
    const spy = new ExportService(contacts, { findByTokenHash: async () => (lookups++, null) } as unknown as ExportRepository, { downloadBaseUrl: BASE });
    await caught(spy.download("not-a-token"));
    expect(lookups).toBe(0);
  });
});

describe("expired export cleanup", () => {
  it("purgeExpired deletes only expired jobs and reports the count", async () => {
    await db.prisma.exportJob.deleteMany();
    const old = await svc().export(admin, { contactIds: ["cnt_1"] });
    tick(EXPORT_TTL_MS + 1);
    const fresh = await svc().export(admin, { contactIds: ["cnt_1"] }); // also purges `old`
    expect(await db.prisma.exportJob.findUnique({ where: { id: old.exportId } })).toBeNull();
    expect(await db.prisma.exportJob.findUnique({ where: { id: fresh.exportId } })).not.toBeNull();

    tick(EXPORT_TTL_MS + 1);
    expect(await svc().purgeExpired()).toBe(1);
    expect(await svc().purgeExpired()).toBe(0);
    expect(await db.prisma.exportJob.count()).toBe(0);
  });
});

describe("export authorization and logging", () => {
  it("requires contacts:export and does nothing otherwise", async () => {
    const before = await db.prisma.exportJob.count();
    for (const scopes of [[], ["contacts:read", "contacts:enrich", "companies:read"]] as const) {
      const error = await caught(svc().export({ ...admin, scopes }, { contactIds: ["cnt_1"] }));
      expect(error).toBeInstanceOf(ForbiddenError);
    }
    expect(await db.prisma.exportJob.count()).toBe(before);
  });

  it("never logs the token or download URL, only the export id and counts", async () => {
    const logs = captureLogs();
    const logged = service(createLogger({ destination: logs.destination }));
    const out = await logged.export(admin, { contactIds: ["cnt_1", "cnt_2"] });
    await logged.download(tokenOf(out.downloadUrl));
    expect(logs.text()).not.toContain(tokenOf(out.downloadUrl));
    expect(logs.text()).not.toContain("/downloads/");
    expect(logs.lines()[0]).toMatchObject({ exportId: out.exportId, keyId: admin.keyId, rowCount: 2 });
  });

  it("scrubs a download URL even if one slips into a log message or error", () => {
    const logs = captureLogs();
    const token = "T".repeat(43);
    const logger = createLogger({ destination: logs.destination });
    logger.info(`fetching ${BASE}/downloads/${token}`);
    logger.error({ err: new Error(`bad ${BASE}/downloads/${token}`) }, "x");
    expect(logs.text()).not.toContain(token);
    expect(logs.text()).toContain("/downloads/[REDACTED]");
  });
});
