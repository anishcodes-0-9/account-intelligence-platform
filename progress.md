# Progress

## Runtime (verified)
Node 24.22.2 (`.nvmrc`, engines `>=24.22.2 <25`), pnpm 10.33.0, Prisma 7.10.1, TypeScript 6.0.3, Vitest 5.1.0, PostgreSQL 17.11 (Docker `postgres:17-alpine`), Docker 29.9.1.
Other dependency versions: `docs/decisions/0001-mcp-sdk-v2-spike.md`.

## Git
Initialized after M3 (M1-M3 were built without Git; no history was reconstructed). Branch `main`. Baseline commit `98906d9` "chore: establish project baseline through M3". Not pushed; no remote.

## M1 - Foundation and SDK spike: complete, approved

## M2 - Database, migrations, seed, repositories: complete, approved
Done: Node 24 switch (M1 suite re-verified on it); 5-model schema + `20261103094812_init` migration (with 3 hand-added CHECK constraints); deterministic idempotent seed (60 companies / 240 contacts); repositories for Company, Contact, Enrichment, ApiKey, Export; tests against real Postgres. Details: `docs/database.md`.

## M3 - Contracts, services, errors, API keys, logging: complete, reviewed and approved
Done: `@aip/contracts` schemas (exact PDF field names); `CompanyService`/`ContactService` (token-based search, scope checks, limits enforced in the service); `AppError` hierarchy + `mapError`; `ApiKeyService` (`aip_<keyId>_<secret>`, SHA-256 + `timingSafeEqual`, expiry, revocation, scopes, throttled `lastUsedAt`); `pnpm keys` CLI; Pino logger with redaction. Details: `docs/api-keys-and-errors.md`.

## Structure
`apps/server` (config, `keys` CLI, temporary spike), `packages/contracts` (Zod schemas), `packages/core` (Prisma, repositories, services, auth, errors, logging, seed), `docs/`, `scripts/` and `examples/` (empty, reserved). `apps/web` not yet created.

## Decisions (agreed)
Modular monolith; MCP SDK v2 only; API keys (no OAuth); Postgres/Prisma 7 with migrations only; whole-token company search with fixed filler terms; out-of-range limits rejected; mock enrichment with synthetic data; Next.js last, REST only. See `CLAUDE.md` and `docs/`.

## Next
- **M4 is the next milestone (not started).** Open defaults: reject whole export if any ID is missing; each enrichment writes a new record.
- M4 Enrichment and export: provider interface + mock fixtures, enrichment service, CSV builder, export service, download-token logic, purge.
- The spike (`SPIKE_API_KEY` in `.env.example`, its tests) is temporary and kept until M5. Temporary spike code lives in `apps/server/src/spike` and `apps/server/test/spike-*`; delete in M5.
