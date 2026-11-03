import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, dropDatabase, prismaCli, queryRows, uniqueName, urlFor } from "./support/test-db.js";

const name = uniqueName("aip_fresh");
const url = urlFor(name);

afterAll(() => dropDatabase(name));

describe("migrations on a completely empty database", () => {
  it("starts empty, migrates, and is reproducible", async () => {
    await createDatabase(name);
    expect(await queryRows(url, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).toEqual([]);

    const first = prismaCli(["migrate", "deploy"], url);
    expect(first).toMatch(/successfully applied/);

    const tables = await queryRows<{ tablename: string }>(
      url,
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`,
    );
    expect(tables.map((t) => t.tablename)).toEqual(["api_keys", "companies", "contacts", "enrichment_records", "export_jobs"]);

    // Applying again is a no-op, and migrate status reports no drift from the migration history.
    expect(prismaCli(["migrate", "deploy"], url)).toMatch(/No pending migrations/);
    expect(prismaCli(["migrate", "status"], url)).toMatch(/Database schema is up to date/);
  });

  it("creates the unique indexes and CHECK constraints the schema relies on", async () => {
    const unique = await queryRows<{ indexname: string }>(
      url,
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE%' AND indexname NOT LIKE '%pkey' ORDER BY 1`,
    );
    expect(unique.map((r) => r.indexname)).toEqual(["api_keys_keyHash_key", "export_jobs_tokenHash_key"]);

    const checks = await queryRows<{ conname: string }>(url, `SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace ORDER BY 1`);
    expect(checks.map((r) => r.conname)).toEqual([
      "companies_employees_nonneg",
      "export_jobs_contact_ids_nonempty",
      "export_jobs_row_count_nonneg",
    ]);
  });
});
