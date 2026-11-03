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

## M5 - Real MCP server, stdio and Streamable HTTP: complete, reviewed and approved
Done: shared `registerTools()` (`apps/server/src/mcp/register-tools.ts`) defines all five tools --
`search_companies`, `get_company`, `search_contacts`, `enrich_contact`, `export_contacts` -- once, with
their `@aip/contracts` schemas and the real `CompanyService`/`ContactService`/`EnrichmentService`/
`ExportService`; both the stdio (`apps/server/src/bin/mcp-stdio.ts`) and Streamable HTTP
(`apps/server/src/bin/mcp-http.ts`, served at `/mcp` via `apps/server/src/mcp/http-app.ts`) entry points
call it through `createAipMcpServer()`, so no tool logic is duplicated between transports. Every thrown
error is caught in the tool handler and mapped through the existing `mapError()` to an `isError` result
(never a raw thrown message, which the SDK would otherwise echo verbatim -- `docs/decisions/0001`).

Authentication reuses `ApiKeyService` unchanged. stdio verifies `AIP_API_KEY` once at startup (exit 1,
no stdout, no credential on stderr, if missing/invalid/expired/revoked) and injects the fixed principal
into every tool call by closure. HTTP verifies the `Authorization: Bearer` header per request in a
Fastify route and carries the verified principal through the MCP SDK's own `AuthInfo` channel
(`AuthInfo.extra`, read back via `ctx.http.authInfo` in each tool handler) -- never derived from
anything the client supplies. Each tool's required scope (`companies:read` / `contacts:read` /
`contacts:enrich` / `contacts:export`, matching the table in `docs/mcp-server.md`) is enforced by the
service's own `requireScope`, producing a `FORBIDDEN` `isError` result on a per-call basis.

Removed the M1 spike entirely (`apps/server/src/spike/*`, `apps/server/test/spike-*`, `SPIKE_API_KEY`);
its SDK findings stay in `docs/decisions/0001-mcp-sdk-v2-spike.md` since M5 relied on them directly.
Added `DOWNLOAD_BASE_URL` to `apps/server/src/config.ts` (defaults to `http://<HOST>:<PORT>`) so
`export_contacts` has a download origin ahead of M6's REST `GET /downloads/:token`.

New protocol-level tests: `apps/server/test/mcp-stdio.test.ts` and `mcp-http.test.ts` each spawn/serve
the real binaries and drive them with the real MCP SDK client (`Client` + `StdioClientTransport` /
`StreamableHTTPClientTransport`) against a real, isolated, migrated Postgres database -- tool discovery,
all five tools executing successfully, unknown ids, invalid arguments, missing/invalid/expired/revoked
keys, insufficient-scope `FORBIDDEN`, a usable export download URL, and no credential/download-URL in
logs. `mcp-parity.test.ts` asserts stdio and HTTP return byte-identical `structuredContent` for the same
input.

Staff-level review round (post-initial-implementation): approved with conditions, then a focused
hardening pass closed every condition without touching the architecture. Added `mcp-http-concurrency.test.ts`
(two real clients, two different keys/scopes, 25 rounds of deliberately interleaved concurrent calls,
plus a database-level check that no principal's writes ever carried the other key's id -- proves
concurrent requests from different principals never cross-contaminate); `mcp-http-revocation.test.ts`
(connect, succeed, revoke the exact key via the real `ApiKeyService`, reuse the same never-reconnected
session, confirm the next call is rejected `401 UNAUTHENTICATED` -- proves the key is re-verified on
every request, not cached from the initial connect); `mcp-http-security.test.ts` (Host/Origin/
DNS-rebinding and malformed-request regression tests ported from the deleted M1 spike, so that coverage
survived the spike's removal); and a stdout/stderr-hygiene test in `mcp-stdio.test.ts` driving one real
tool call with hand-written JSON-RPC frames (the SDK's `StdioClientTransport` exposes `.stderr` but not
raw stdout, so this is the only way to inspect the actual bytes) confirming stdout carries only
JSON-RPC frames and diagnostics land on stderr only. The SDK-level-shape-rejection vs.
service-level-`ValidationError`-rejection difference in `isError` result shape was investigated, found to
have no clean fix without breaking tool-discovery schemas, and is documented in `docs/mcp-server.md`
("Validation error shapes") with a regression test locking in the distinction. 241 tests passing (233
after the initial M5 implementation + 8 new hardening-round tests), run clean twice in full and the new
timing-sensitive files run three additional times with no flakiness. Details: `docs/mcp-server.md`.

## M6 - REST API and CSV downloads: complete, reviewed and approved
Done: `GET /downloads/:token` (`apps/server/src/rest/downloads.ts`) serves `ExportService.download`
unchanged from M4/M5 -- unknown, malformed and expired tokens all fall through its single `NotFoundError`
to an identical `404`; the route takes no Authorization header since the 32-byte token itself (only its
SHA-256 stored) is the credential, as it already was. Five REST endpoints
(`apps/server/src/rest/routes.ts`) -- `GET /api/companies`, `GET /api/companies/:companyId`,
`GET /api/contacts`, `POST /api/contacts/:contactId/enrich`, `POST /api/contacts/export` -- call the
exact `CompanyService`/`ContactService`/`EnrichmentService`/`ExportService` methods the MCP tools call,
with the same `@aip/contracts` schemas; no business rule is duplicated. Bearer auth
(`apps/server/src/rest/auth.ts`) reuses `ApiKeyService.verify` unchanged, and each route's required
scope is enforced inside the service itself (`requireScope`), identically to MCP. `apps/server/src/
http-app.ts`'s `buildHttpApp()` mounts the REST routes and the download route on the same Fastify
instance `buildMcpHttpApp()` (M5, untouched) already serves `/mcp` from, so one process/port serves all
three; `bin/mcp-http.ts` now calls `buildHttpApp()` instead of `buildMcpHttpApp()` directly -- its only
change. No new database tables; no dependencies added.

New integration tests (`apps/server/test/rest-api.test.ts`, `downloads.test.ts`,
`rest-mcp-parity.test.ts`): a real Node `http.request` client against the real Fastify app, against a
real, isolated, migrated Postgres database. Covered: all five REST operations succeeding; missing,
invalid, expired and revoked keys (`401`, credential never echoed); insufficient scope (`403 FORBIDDEN`);
validation failures and missing records (`400`/`404`); a full MCP `export_contacts` call followed by a
real HTTP download of the resulting CSV (correct `Content-Type`/`Content-Disposition`/row count);
REST's own `POST /api/contacts/export` followed by downloading that same export, proving both transports
write to one export store; unknown and malformed download tokens returning byte-identical `404` bodies;
and that REST and MCP return identical data/identical `FORBIDDEN` enforcement for the same input and key.
The expired-token case needed a controllable clock (the same `now` injection point
`packages/core/test/export-service.test.ts` already uses) rather than waiting on the real 15-minute TTL,
applied only to that one sub-test via a second, standalone Fastify app on the same database -- documented
in `docs/rest-api.md`. 262 tests passing (241 after M5's hardening round + 21 new M6 tests), full suite
run clean twice. Details: `docs/rest-api.md`; `docs/mcp-server.md` updated to reflect that `mcp-http.ts`
now serves REST and downloads too.

Limitations: no OAuth, no external enrichment provider (unchanged from M3/M4); REST has not been tested
against any client other than Node's own `http` module (no browser/CORS testing, since `apps/web` is not
built yet).

## M7 - MCP client demonstration: complete, awaiting review
Done: a reproducible, end-to-end demonstration of the platform through two genuine MCP-compatible
clients against the real, running server (`pnpm mcp:http`) and a real database -- no REST calls and no
test framework substitute for any of it. Spawning a nested, non-interactive Claude Code agent to drive
live tool calls as the client was blocked by this environment's own sandbox policy ("Create Unsafe
Agents"), so the brief's explicit fallback was used instead: MCP Inspector CLI
(`@modelcontextprotocol/inspector --cli`, an independent third-party client) for tool discovery and
auth/scope probing, and the MCP TypeScript SDK's own `Client`/`StreamableHTTPClientTransport` -- the same
client this project's tests already use and `docs/mcp-server.md` already documents as "tested against"
-- in a new demo script (`apps/server/demo/mcp-client-demo.ts`, run via `pnpm --filter @aip/server
demo:mcp`) for the full workflow and the concurrency demonstration. Claude Code itself did confirm this
environment can connect to the server at all (`claude mcp add`/`claude mcp list`), satisfying the
brief's first-choice client for connection configuration, short of live interactive tool-calling inside
this one non-interactive session.

Covered and captured as real evidence under `docs/demo/evidence/` (see `docs/demo/README.md` for the
full breakdown): all five tools discovered with their exact schemas; missing/malformed/expired/revoked
keys all rejected identically (`401 UNAUTHENTICATED`, key never echoed); a companies-only key rejected
with `FORBIDDEN` on `export_contacts` (plus a documented, genuine finding -- MCP Inspector CLI's strict
`outputSchema` validation can't display that same `isError` result, since `export_contacts`'s schema
only describes the success shape, the same limitation `docs/mcp-server.md` already documents from a
different angle); a real `search_companies` (AI companies in Australia) -> `get_company` ->
`search_contacts` -> `enrich_contact` -> `export_contacts` -> CSV download workflow against real seed
data, with the downloaded CSV's header, row count and contact ids verified against the tool's own
`rowCount`; and a bounded-concurrency run of six `get_company` calls for six different company ids,
capped at 3 in flight at once by a small `Semaphore` the demo script itself owns (no dependency added),
with a captured per-call timeline proving real overlap -- explicitly not something MCP itself provides.

No business logic changed; no new dependencies; no frontend built. New files: `apps/server/demo/
mcp-client-demo.ts`, `docs/demo/README.md`, `docs/demo/mcp-client-config.example.json`,
`docs/demo/evidence/*`, root `README.md` (did not exist before this milestone). `apps/server/
tsconfig.json`'s `include` gained `demo`; `apps/server/package.json` gained a `demo:mcp` script.
`pnpm typecheck`/`lint`/`test` all green (test suite unchanged from M6: 262 passing -- this milestone
added no new automated tests, since the brief's point was a real client demonstration, not more
integration coverage).

Limitations: no screenshots/recordings (no display in this environment to capture from; manual capture
steps for a human with MCP Inspector's web UI or an interactive Claude Code session are documented in
`docs/demo/README.md` instead of being fabricated); live, interactive Claude-Code-as-client tool-calling
within one session is configuration-verified but not executed, for the sandbox-policy reason above, not
an AIP limitation.

A post-review reproducibility and evidence audit found and fixed one real issue: `downloadUrl`s (the
project's own credential, per CLAUDE.md -- "never log them or store the raw token") were being saved in
cleartext in evidence JSON and printed to the console. Fixed with a `redactDownloadUrl()` helper in the
demo script, mirroring the real request logger's own `/downloads/<token>` scrubbing
(`packages/core/src/logging/logger.ts`); every evidence file now carries `***redacted***` in place of
the token, while the script still fetches the real URL to verify each download. The audit also: added a
second, "clean happy path" run (`05b-happy-path-workflow.json`, `happy-path-export.csv`) using two
contacts whose `SUCCESS` enrichment outcome is deterministic and asserted at runtime, alongside the
original mixed-outcome run (kept as error-handling evidence); strengthened the concurrency evidence with
a live sampler of the semaphore's actual in-flight counter (polled every ~1ms during the run), not just
reconstructed start/end timestamps; rewrote `docs/demo/README.md`'s "Clients used" section so it cannot
be read as Claude Code having executed the workflow -- Claude Code's role is connection verification
only (`claude mcp add`/`list`/`get`, actually run against the live server this time and captured as
`00-claude-code-mcp-connection.txt`, not just described), MCP Inspector CLI is the independent
discovery/auth client, and the MCP SDK's own `Client` is named as the one that ran the complete workflow
and concurrency demo; and re-verified the entire setup/reproduction path from a literal fresh `.env.example`
copy with no undocumented manual step found. `pnpm typecheck`/`lint`/`test` (262 passing) and
`git diff --check` all re-confirmed green after these changes.

## Next
- **M8 is next (not started):** `apps/web` (Next.js), talking to the M6 REST API only.
