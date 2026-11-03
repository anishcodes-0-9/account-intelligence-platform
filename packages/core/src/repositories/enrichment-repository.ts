import type { DbClient, EnrichmentRecord, EnrichmentStatus, Prisma } from "../db.js";

export interface NewEnrichmentRecord {
  contactId: string;
  provider: string;
  status: EnrichmentStatus;
  returned: Prisma.InputJsonValue;
  provenance: Prisma.InputJsonValue;
  error?: string | undefined;
}

export class EnrichmentRepository {
  constructor(private readonly db: DbClient) {}

  create({ error, ...rest }: NewEnrichmentRecord): Promise<EnrichmentRecord> {
    return this.db.enrichmentRecord.create({ data: { ...rest, ...(error !== undefined ? { error } : {}) } });
  }

  /** Newest first. */
  listForContact(contactId: string): Promise<EnrichmentRecord[]> {
    return this.db.enrichmentRecord.findMany({
      where: { contactId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }
}
