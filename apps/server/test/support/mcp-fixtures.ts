// Shared real-database fixtures for the MCP protocol-level tests (stdio and HTTP). Builds one isolated,
// migrated database, seeds the real company/contact fixtures, and mints real API keys of different scope
// profiles through the real ApiKeyService -- the same code path `pnpm keys create` uses.
import { ApiKeyRepository, ApiKeyService, createLogger, seedDatabase } from "@aip/core";
import type { Scope } from "@aip/contracts";
import { createIsolatedDb, type IsolatedDb } from "../../../../packages/core/test/support/test-db.js";

export interface McpTestKeys {
  /** All four scopes. */
  full: string;
  /** companies:read only -- lacks every other scope. */
  companiesOnly: string;
  /** Valid shape, but revoked immediately after creation. */
  revoked: string;
  /** Valid shape, but already expired. */
  expired: string;
}

export interface McpFixtures {
  db: IsolatedDb;
  keys: McpTestKeys;
  /** The real ApiKeyService backing `keys`, exposed so tests can mint/revoke keys of their own at runtime. */
  apiKeyService: ApiKeyService;
  close: () => Promise<void>;
}

/** Parses the `keyId` out of a raw `aip_<keyId>_<secret>` key, as `ApiKeyService.revoke` needs. */
export function keyIdOf(key: string): string {
  const id = /^aip_([a-z0-9]+)_/.exec(key)?.[1];
  if (!id) throw new Error("could not parse generated key id");
  return id;
}

export async function buildMcpFixtures(templateDb: string): Promise<McpFixtures> {
  const db = await createIsolatedDb(templateDb);
  await seedDatabase(db.prisma);

  const apiKeyService = new ApiKeyService(new ApiKeyRepository(db.prisma), { logger: createLogger({ level: "silent" }) });
  const create = async (name: string, scopes: Scope[], expiresAt?: string): Promise<string> =>
    (await apiKeyService.create({ name, scopes, ...(expiresAt ? { expiresAt } : {}) })).key;

  const full = await create("full", ["companies:read", "contacts:read", "contacts:enrich", "contacts:export"]);
  const companiesOnly = await create("companies-only", ["companies:read"]);
  // Expires 50ms in the future (ApiKeyService.create rejects an already-past expiresAt); the short
  // sleep below lets real wall-clock time pass it before any test uses the key.
  const expired = await create("expired", ["companies:read", "contacts:read", "contacts:enrich", "contacts:export"], new Date(Date.now() + 50).toISOString());
  await new Promise((resolve) => setTimeout(resolve, 100));

  const revokedKey = await create("revoked", ["companies:read", "contacts:read", "contacts:enrich", "contacts:export"]);
  await apiKeyService.revoke(keyIdOf(revokedKey));

  return {
    db,
    keys: { full, companiesOnly, revoked: revokedKey, expired },
    apiKeyService,
    close: () => db.drop(),
  };
}
