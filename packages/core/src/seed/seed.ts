import type { PrismaClient } from "../db.js";
import { buildCompanies, buildContacts } from "./data.js";

export interface SeedResult {
  companies: number;
  contacts: number;
}

/**
 * Idempotent: upserts by deterministic id, never deletes. Contact upserts only touch seed-owned
 * fields, so email/linkedin written later by enrichment survive a re-seed.
 */
export async function seedDatabase(db: PrismaClient): Promise<SeedResult> {
  const companies = buildCompanies();
  const contacts = buildContacts();

  await db.$transaction(
    companies.map((c) => {
      const { id, ...fields } = c;
      return db.company.upsert({ where: { id }, create: c, update: fields });
    }),
  );
  await db.$transaction(
    contacts.map((c) => {
      const { id, ...fields } = c;
      return db.contact.upsert({ where: { id }, create: c, update: fields });
    }),
  );

  return { companies: await db.company.count(), contacts: await db.contact.count() };
}
