import type { ExportJob, PrismaClient } from "../db.js";

export interface NewExportJob {
  apiKeyId: string;
  contactIds: string[];
  rowCount: number;
  content: string;
  tokenHash: string;
  expiresAt: Date;
}

export class ExportRepository {
  constructor(private readonly db: PrismaClient) {}

  create(data: NewExportJob): Promise<ExportJob> {
    return this.db.exportJob.create({ data });
  }

  findByTokenHash(tokenHash: string): Promise<ExportJob | null> {
    return this.db.exportJob.findUnique({ where: { tokenHash } });
  }

  /** Returns the number of expired exports removed. */
  async deleteExpired(now: Date): Promise<number> {
    const { count } = await this.db.exportJob.deleteMany({ where: { expiresAt: { lt: now } } });
    return count;
  }
}
