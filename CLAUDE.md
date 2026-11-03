# Account Intelligence Platform (AIP)

MCP server (stdio + Streamable HTTP) exposing company/contact intelligence, plus REST API and a Next.js UI (last).
Source of truth: the assignment PDF. Plan: `account-intelligence-architecture.md` (superseded where `docs/decisions/` says so).
Status and next steps: `progress.md`.

## Architecture rules
- `contracts` (Zod schemas/types) <- `core` (services, repos, auth policy, errors) <- `apps/server` (Fastify REST, `/mcp`, stdio bin). `apps/web` talks to REST only.
- `core` must not import Fastify, the MCP SDK or Next. MCP/REST handlers stay thin: parse -> authorize -> call service -> map result/error.
- One shared `registerTools()` serves both transports. Never duplicate tool logic.
- Exact tool names and wire fields come from the PDF (`employees`, `linkedin`, `title`, `name`). Additions must be additive.
- MCP SDK is v2 only (`@modelcontextprotocol/server|client|node|fastify`). Never use v1 APIs (`@modelcontextprotocol/sdk`, `.tool()`, `StreamableHTTPServerTransport`).

## Standards
- Strict TS (incl. `exactOptionalPropertyTypes`), no `any`, Zod at every external boundary.
- Services take `(principal, rawInput)`, validate with the `@aip/contracts` schema, check scope, and throw `AppError` subclasses. Transport adapters call `mapError(error, logger)` to turn anything into a safe response (REST status + body, MCP `isError` result).
- Tool handlers must never throw raw errors: the SDK returns a thrown error's message to the client (see `docs/decisions/0001`). Map to `AppError` codes; unexpected -> generic INTERNAL, log detail server-side.
- stdio: stdout is protocol-only. Diagnostics go to stderr.

## Security
- No secrets in code/logs/commits. `.env` is git-ignored; `.env.example` has placeholders only.
- Never log Authorization headers, API keys, download tokens. Store only key hashes.
- Fail closed on missing/invalid credentials.

## Commands
Node 24 is required (`.nvmrc`; run `nvm use`). Setup order matters for tests:
1. `pnpm install`
2. `cp .env.example .env`
3. `pnpm db:up` (Postgres 17 on host port 5433)
4. `pnpm db:generate` (Prisma client; git-ignored, must be regenerated after schema changes or a fresh clone)
5. `pnpm db:migrate` then `pnpm db:seed` (dev database; both are safe to rerun)
- `pnpm typecheck` / `pnpm lint` / `pnpm test` (needs steps 1-4; tests build their own throwaway databases from the migrations, never touching the dev DB)
- Schema change: edit `schema.prisma`, `pnpm db:migrate:dev --name <name>`, commit the migration. Never `db push`.
- API keys: `pnpm keys create --name <n> --scopes companies:read,contacts:read [--expires-in-days N]`, `pnpm keys list`, `pnpm keys revoke <id>` (raw key shown once at creation)
- `pnpm spike:http`, `pnpm spike:stdio` (temporary M1 spike, deleted in M5)

## Enrichment and export
- `EnrichmentProvider.enrich` returns `{email, linkedin}` or throws; the service derives SUCCESS/PARTIAL/NOT_FOUND from the fields and turns a throw into a FAILED record plus `PROVIDER_ERROR`. Providers must declare `synthetic`; nothing is ever `verified`.
- Download URLs (`<base>/downloads/<token>`) are credentials: never log them or store the raw token. The logger scrubs `/downloads/<token>`; keep it that way.
- Secret redaction has one source of truth: `packages/core/src/security/redact.ts`. Persistence (`enrichment/sanitize-error.ts`) and logging (`logging/logger.ts`'s `describeError`) both redact through it; do not add a second pattern list. Logging a raw `Error`/`cause` (e.g. `mapError`'s `logger.error({ err: error })`) is fine *because* `createLogger` intercepts every Error before Pino sees it and replaces it with `describeError`'s plain, redacted representation -- Pino's own standard `err` serializer is never called with a live Error. If you log through anything other than `createLogger`, redact through `redactSecrets` yourself first.

## Git and dependencies
- Git initialized after M3 (baseline `98906d9`, branch `main`). Do not commit, push or deploy without explicit approval. Never commit `.env` or raw keys.
- State a dependency's purpose before adding it; pin exact versions (`.npmrc` save-exact).

## Workflow
One milestone at a time; stop for review. Never claim something works without running it; report exact commands and results.
Definition of done per milestone: acceptance criteria in `progress.md` met, `typecheck`, `lint`, `test` green.
