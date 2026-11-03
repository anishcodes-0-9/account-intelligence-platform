# Progress

## Runtime (verified)
Node 24.22.2 (`.nvmrc`, engines `>=24.22.2 <25`), pnpm 10.33.0, Prisma 7.10.1, TypeScript 6.0.3, Vitest 5.1.0, PostgreSQL 17.11 (Docker `postgres:17-alpine`), Docker 29.9.1.
Other dependency versions: `docs/decisions/0001-mcp-sdk-v2-spike.md`.

## M1 - Foundation and SDK spike: complete, approved

## M2 - Database, migrations, seed, repositories: complete, approved
Done: Node 24 switch (M1 suite re-verified on it); 5-model schema + `20261103094812_init` migration (with 3 hand-added CHECK constraints); deterministic idempotent seed (60 companies / 240 contacts); repositories for Company, Contact, Enrichment, ApiKey, Export; tests against real Postgres. Details: `docs/database.md`.

## M3 - Contracts, services, errors, API keys, logging: complete, awaiting review
Done: `@aip/contracts` schemas (exact PDF field names); `CompanyService`/`ContactService` (token-based search, scope checks, limits enforced in the service); `AppError` hierarchy + `mapError`; `ApiKeyService` (`aip_<keyId>_<secret>`, SHA-256 + `timingSafeEqual`, expiry, revocation, scopes, throttled `lastUsedAt`); `pnpm keys` CLI; Pino logger with redaction. Details: `docs/api-keys-and-errors.md`.

## Next
- M4 Enrichment and export: provider interface + mock fixtures, enrichment service, CSV builder, export service, download-token logic, purge.
- Temporary spike code lives in `apps/server/src/spike` and `apps/server/test/spike-*`; delete in M5.
