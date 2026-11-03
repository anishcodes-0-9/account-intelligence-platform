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

## M4 - Enrichment and CSV export: complete, reviewed, awaiting final approval (uncommitted)
Done: `MockEnrichmentProvider` (deterministic, reserved `.example` domains, `synthetic: true` / `verified: false` provenance); `EnrichmentService` (new `EnrichmentRecord` per attempt, Contact updated only with returned fields, FAILED -> `PROVIDER_ERROR`); CSV builder (RFC 4180 quoting, formula-injection prefixing); `ExportService` (<=200 ids, all-or-nothing NOT_FOUND, 32-byte token with only SHA-256 stored, 15-minute expiry, `download(token)`, `purgeExpired()`); download-URL scrubbing in the logger. Contract: `ExportContactsInputSchema.contactIds` has a schema-level `.max(1000)` payload-size cap distinct from the service's 200-id `EXPORT_LIMIT` business rule, which it does not override. Details: `docs/enrichment-and-export.md`.
Review corrections (post-initial-implementation): SUCCESS/PARTIAL enrichment writes (record + contact update) now run in one Prisma interactive `$transaction`, built from tx-bound `ContactRepository`/`EnrichmentRepository` instances so the two writes genuinely share a connection; `EnrichmentService` now takes the raw `PrismaClient` rather than pre-built repositories, to rule out two repos silently using different clients. The atomicity/rollback test exercises `EnrichmentService.enrich()` itself (not a hand-written transaction) by installing a Postgres trigger, scoped to one contact id, that forces the contact update to fail; the trigger and its function are dropped in a `finally` block.

Security fix (logging leak, found during the staff-level M4 review, corrected twice): `mapError` logging a `ProviderError` with a `cause` (as every FAILED enrichment attempt produces) leaked the raw, unsanitized provider message and stack into application logs. Root cause: Pino's standard `err` serializer concatenates `cause.message`/`cause.stack` from the *original* Error chain into its own top-level `message`/`stack` fields before any scrubbing could run -- confirmed live with `password=S3kretPass!` appearing verbatim in captured JSON log output.

A first fix widened the logger's redaction patterns but kept calling Pino's standard `err` serializer on the live Error. The final fix instead stops any live `Error` (or its `cause`) from ever reaching Pino: `logging/logger.ts`'s new `describeError` builds the loggable representation itself -- `type`, a redacted `message`, a redacted `stack`, and a redacted `cause` (recursive, capped at 5 levels, guarded against a circular `cause` chain) -- entirely in application code, never delegating to `pino.stdSerializers.err`. It runs both as the `logMethod` hook (so an Error anywhere in a logged object is caught, not only under `err`) and as the registered `err` serializer, and is exported for direct testing. `mapError` and `logging/logger.ts`'s path are otherwise unchanged in shape, so full server-side diagnostics (stack traces, SQL text, upstream connection errors) remain available, matching the pre-existing M3 design (`test/logger.test.ts`, `test/errors.test.ts`, both still passing unmodified) -- only the gap in what counts as a secret, and the reliance on Pino's serializer, were closed.

One shared redaction utility, `packages/core/src/security/redact.ts` (Bearer tokens, `aip_<keyId>_<secret>` keys, Authorization headers, connection-string `user:password@host`, and `password`/`secret`/`token`/`access_token`/`refresh_token`/`apiKey`/`key`/`credential` assignments), is used by both persistence (`sanitizeProviderError`) and logging (`describeError`).

A third pass closed a remaining gap: `logger.ts`'s `scrub()` could still pass an unrecognized object (a custom class instance, `Map`, `Set`, `Date`, `Buffer`/typed array) through to Pino untouched once its prototype wasn't `Object.prototype`, which could expose arbitrary fields a string-pattern check would never see. `scrub()` now normalizes every value into `null`/string/number/boolean/array/plain-object before it reaches Pino: a `Date` becomes an ISO string, `Map`/`Set` become `{type, size, entries/values}` (each entry normalized the same way), a `Buffer`/typed array becomes `{type, byteLength}` (never its bytes), and any other class instance becomes `{type}` only -- its own fields are never read. A sensitive key name (`password`, `token`, `apiKey`, ...) is now redacted at *any* nesting depth inside `scrub()` itself, not only within Pino's own 2-level wildcard `redact.paths` -- this closed a real leak a new test found (a `password` field six levels deep in a circular object survived Pino's own wildcarding). 222 tests passing (188 M4-baseline + 16 atomicity/sanitization/export-boundary + 18 log-redaction/value-normalization regression tests).

New `packages/core/test/log-redaction.test.ts` (11 tests) drives the real `mapError`+`createLogger` path and `describeError` directly: none of the fake secrets appear in captured output; no live Error instance survives in the described representation (checked recursively); a circular cause chain terminates instead of recursing forever; an unbounded chain is capped; a nested Error in structured log context (not under `err`) is sanitized too; non-secret diagnostic detail and existing error classification are preserved. 215 tests passing (188 M4-baseline + 16 atomicity/sanitization/export-boundary + 11 log-redaction regression tests).

212 tests passing (188 M4-baseline + 16 atomicity/sanitization/export-boundary + 8 new log-redaction regression tests).

## Next
- **M5 MCP server is next (not started):** shared `registerTools`, stdio + `/mcp`, errors via `mapError`, delete the spike. M6 adds REST and `GET /downloads/:token` (calls `ExportService.download`).
- The spike (`SPIKE_API_KEY` in `.env.example`, its tests) is temporary and kept until M5. Temporary spike code lives in `apps/server/src/spike` and `apps/server/test/spike-*`; delete in M5.
