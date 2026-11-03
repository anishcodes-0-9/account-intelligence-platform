import type { ApiKey, PrismaClient } from "../db.js";

export interface NewApiKey {
  name: string;
  keyHash: string;
  scopes: string[];
  expiresAt?: Date | undefined;
}

export class ApiKeyRepository {
  constructor(private readonly db: PrismaClient) {}

  create({ expiresAt, ...rest }: NewApiKey): Promise<ApiKey> {
    return this.db.apiKey.create({ data: { ...rest, ...(expiresAt ? { expiresAt } : {}) } });
  }

  findById(id: string): Promise<ApiKey | null> {
    return this.db.apiKey.findUnique({ where: { id } });
  }

  list(): Promise<ApiKey[]> {
    return this.db.apiKey.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  }

  markUsed(id: string, at: Date): Promise<ApiKey> {
    return this.db.apiKey.update({ where: { id }, data: { lastUsedAt: at } });
  }

  revoke(id: string, at: Date): Promise<ApiKey> {
    return this.db.apiKey.update({ where: { id }, data: { revokedAt: at } });
  }
}
