# Submission checklist

## Source of the requirements below — read this first

The original six-page **"Fullstack Engineer Assignment"** PDF is now available (supplied directly in
this conversation) and is the sole authority for every requirement below. Every row in this file has been
re-verified against its literal text — its "MCP Tools" section (tool names and exact input/output JSON
shapes), "Authentication", "Data Layer", "MCP Client Demonstration", "Non-Functional Requirements (any
2)", and "Deliverables" sections — not against `account-intelligence-architecture.md` (the Phase 0
engineering plan), which is cited below only where it documents this project's own implementation
decisions, never as a stand-in for the assignment itself.

Two things worth stating plainly: the PDF's example tool outputs are minimal (e.g. `enrich_contact`
returns only `{email, linkedin}`; `get_company` has no `country` field); this implementation's actual
responses carry additional fields (`status`, `provider`, `provenance` on `enrich_contact`; `country` on
`get_company`; `exportId`/`expiresAt` on `export_contacts`). These are additive, not deviations — every
PDF-required field is present with the PDF-required name, and `CLAUDE.md`'s own rule is "additions must
be additive." Second: the PDF's authentication requirement does not itself ask for per-scope permissions
(`companies:read` etc.) — that is this project's own design choice in service of "reject unauthenticated
requests," not a literal assignment requirement, and is labeled as such below rather than presented as
something the PDF demanded.

Status values: **Complete** (implemented and evidenced), **Partial** (implemented in part, or evidenced
in part), **Not Complete** (not implemented). Nothing below is marked Complete without a file path, test,
or command backing it.

## 1. Required MCP tools

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | `search_companies` | Complete | `apps/server/src/mcp/register-tools.ts`; discovered + executed in `docs/demo/evidence/01-tool-discovery.inspector.json`, `02-connect-and-discover.json`, `05-end-to-end-workflow.json` (step 1) |
| 2 | `get_company` | Complete | same files; `05-end-to-end-workflow.json` step 2; also the concurrency demo (`06-bounded-concurrency.json`) calls it 6x concurrently |
| 3 | `search_contacts` | Complete | same files; `05-end-to-end-workflow.json` step 3 |
| 4 | `enrich_contact` | Complete | `05-end-to-end-workflow.json` step 4 (mixed outcome incl. `PROVIDER_ERROR`); `05b-happy-path-workflow.json` (deterministic `SUCCESS`) |
| 5 | `export_contacts` | Complete | `05-end-to-end-workflow.json`/`05b-...json` step 5+6, `export.csv`, `happy-path-export.csv` |

Tool names, input/output field names (`employees`, `linkedin`, `title`, `name`, etc.) are unchanged
from the assignment's required shapes — see `docs/mcp-server.md` ("The five tools" table) and
`packages/contracts/src`.

## 2. Authentication and authorization requirements

| Requirement | Status | Evidence |
|---|---|---|
| Authentication using API keys or OAuth 2.1 + PKCE | Complete (API keys chosen; documented decision) | `packages/core/src/auth/api-key-service.ts`; `docs/api-keys-and-errors.md`; decision recorded in `progress.md` ("Decisions (agreed)") |
| Rejection of unauthenticated requests | Complete | MCP: `docs/demo/evidence/03-auth-failures.json` (missing/malformed/expired/revoked, all `401 UNAUTHENTICATED`); REST: `apps/server/test/rest-api.test.ts` |
| Scope enforcement | Complete | `docs/demo/evidence/04-scope-forbidden.json` + `01b-inspector-auth-scope.txt` (companies-only key rejected calling `export_contacts`, `403 FORBIDDEN`); enforced identically in REST (`apps/server/test/rest-api.test.ts`) |
| Key lifecycle (create/show-once/hash/expire/revoke) | Complete | `apps/server/src/bin/keys.ts`; `packages/core/src/auth/api-key-service.ts`; `docs/api-keys-and-errors.md` |
| Fail closed on missing/invalid credentials | Complete | stdio: process exits before serving (`apps/server/src/bin/mcp-stdio.ts`); HTTP: `401` before any MCP/REST processing (`apps/server/src/rest/auth.ts`, `apps/server/src/mcp/http-app.ts`) |

## 3. Persistence and data requirements

| Requirement | Status | Evidence |
|---|---|---|
| PostgreSQL, SQLite, or in-memory persistence | Complete (PostgreSQL + Prisma, documented decision) | `packages/core/prisma/schema.prisma`; `docs/database.md` |
| Seed data: at least 50 companies and 200 contacts | Complete — 60 companies / 240 contacts | `packages/core/src/seed/data.ts`, `packages/core/src/seed/seed.ts`; verified by `packages/core/test/seed.test.ts` |

## 4. MCP client demonstration requirements

The PDF requires demonstration with one of: Claude Desktop, Cursor, ChatGPT Apps, or a custom MCP
client, with screenshots or a short video showing tool discovery, tool execution, authentication flow,
and error handling.

| Requirement | Status | Evidence |
|---|---|---|
| Demonstration with an MCP-compatible client | Complete | The MCP TypeScript SDK's own `Client` (`apps/server/demo/mcp-client-demo.ts`) qualifies as the PDF's "custom MCP client" option — real Streamable HTTP, real server, real DB. MCP Inspector CLI and Claude Code (connection/health-check only) are additional, non-required clients also exercised; see `docs/demo/README.md` |
| Tool discovery evidence | Complete | `docs/demo/evidence/01-tool-discovery.inspector.json`, `02-connect-and-discover.json` |
| Tool execution evidence | Complete | `docs/demo/evidence/05-end-to-end-workflow.json`, `05b-happy-path-workflow.json` |
| Authentication flow evidence | Complete | `docs/demo/evidence/03-auth-failures.json`, `00-claude-code-mcp-connection.txt` |
| Error handling evidence | Complete | `docs/demo/evidence/04-scope-forbidden.json`, `01b-inspector-auth-scope.txt`, `03-auth-failures.json`, and `05-end-to-end-workflow.json`'s `PROVIDER_ERROR` case |

**On Claude Desktop specifically:** this submission's instructions note that the application was
"independently verified through Claude Desktop." No screenshot, recording, or log file documenting a
Claude Desktop session exists anywhere in this repository or working tree as of this check — so that
verification, if it happened, is not yet evidenced here and this checklist does not claim it as such. The
MCP-compatible-client requirement above is already met independently through the custom-MCP-client (SDK)
and Inspector-CLI evidence; a Claude Desktop screenshot would be additional, not required to close this
row, but should be added if you want it cited explicitly.

## 5. Documentation and deliverable requirements

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 12 | Source code repository | Complete | this Git repository, pushed to `origin` |
| 13 | README with setup instructions | Complete | `README.md` (rewritten this milestone) |
| 14 | Architecture diagram | Complete | `docs/architecture.md` (Mermaid) |
| 15 | Demo video, ≤5 minutes | Partial | `docs/demo/video-script.md`; see gap below |
| 16 | Example MCP client configuration | Complete | `docs/demo/mcp-client-config.example.json`; linked from README |

## 6. Non-functional requirements

The PDF's "Non-Functional Requirements (any 2)" lists: error handling, validation, logging, rate
limiting, type safety, API documentation, clean architecture, readable code — any two satisfy the
requirement. This project demonstrates more than two:

| Item | Status | Evidence |
|---|---|---|
| Error handling | Complete | `AppError` hierarchy + `mapError()`, `packages/core/src/errors/*`; consistent codes across MCP/REST |
| Validation | Complete | Zod schemas at every external boundary, `packages/contracts/src/*` |
| Logging | Complete | Structured Pino logging with multi-layer redaction, `packages/core/src/logging/logger.ts`, `docs/api-keys-and-errors.md` |
| Type safety | Complete | Strict TypeScript, `exactOptionalPropertyTypes`, no `any` (`tsconfig.base.json`; `pnpm typecheck` green) |
| API documentation | Complete | `docs/rest-api.md`, `docs/mcp-server.md` (hand-written; no OpenAPI/Swagger generator wired up — see gap below) |
| Clean architecture | Complete | `contracts <- core <- apps/server` layering enforced (`core` has zero Fastify/MCP SDK imports); `docs/architecture.md` |
| Readable code | Complete | small files, no god files, consistent naming — see repository structure under `packages/`, `apps/server/src/` |
| Rate limiting | Not Complete | genuine gap, see below |

## 7. This project's own internal definition of done (not a PDF requirement — see `account-intelligence-architecture.md` §18)

| Item | Status | Evidence |
|---|---|---|
| All five required tools work | Complete | see §1 above |
| Both transports work | Complete | stdio (`apps/server/test/mcp-stdio.test.ts`) and Streamable HTTP (`mcp-http.test.ts`); parity test `mcp-parity.test.ts` |
| Claude Code genuinely discovers and executes the tools | Partial | Claude Code genuinely connected and health-checked the live server (`claude mcp add/list/get`, `docs/demo/evidence/00-claude-code-mcp-connection.txt`); it did **not** execute the live tool-call workflow in this environment — see gap below |
| Unauthenticated requests are rejected | Complete | see §2 above |
| Database has ≥50 companies and ≥200 contacts | Complete — 60/240 | see §3 above |
| Setup and migrations work from a clean environment | Complete | re-verified this milestone from a literal fresh `.env.example` copy (see `progress.md`, M7 audit note) |
| Enrichment returns truthful, traceable results | Complete | `MockEnrichmentProvider` always declares `synthetic: true`/`verified: false`; `docs/enrichment-and-export.md` |
| CSV export is functional and protected | Complete | expiring, hashed-token download (`packages/core/src/exports/*`); `docs/demo/evidence/export.csv` |
| Error handling and validation are demonstrated | Complete | see §6 |
| Automated tests pass | Complete | 262/262, see §8 below |
| Documentation is reproducible | Complete | re-verified from a fresh `.env.example` copy, see `progress.md` |
| Required demonstration evidence exists | Complete | `docs/demo/evidence/*` |

## 8. Genuine remaining gaps

These are stated plainly rather than hidden:

1. **No demo video recorded.** This environment is a non-interactive CLI session with no display, so a
   screen-and-voice recording cannot be produced here. `docs/demo/video-script.md` gives an exact,
   realistic script and the exact commands to run while recording; recording it is a manual step for a
   human.
2. **No screenshots captured.** Same reason — no display in this environment. `docs/demo/README.md`
   ("Manual screenshot capture") already documents the exact manual steps; nothing here has been
   fabricated as a substitute.
2a. **No Claude Desktop evidence in-repo.** This submission's instructions state the application was
   "independently verified through Claude Desktop," but no screenshot, recording, or log from a Claude
   Desktop session exists in this repository or working tree. If that verification is meant to be cited
   as part of the submission, capturing and adding that evidence is still an outstanding manual step; the
   MCP-client-demonstration requirement itself is already satisfied independently (§4 above) without it.
3. **Claude Code did not execute the live multi-step tool-calling workflow**, only connection/health-check
   verification (`claude mcp add/list/get`). Spawning a nested, non-interactive Claude Code agent to drive
   live tool calls was blocked by this sandbox's own policy ("Create Unsafe Agents"), unrelated to the AIP
   server. The MCP TypeScript SDK's own `Client` (the same client this project's test suite already uses)
   performed the actual end-to-end workflow and concurrency demonstration instead, as documented in
   `docs/demo/README.md`.
4. **No rate limiting implemented.** The architecture plan proposed it (§10.4); it was not required to
   satisfy the "at least two" non-functional bar, which is already exceeded by the other six items, so it
   was not built. This is a real, acknowledged gap against the fuller architecture proposal, not a
   misrepresentation of what's in the code.
5. **No API health endpoint** (`system://health` / `/health`). Proposed in the architecture plan, not
   implemented. Same reasoning as rate limiting: not required by the assignment's own requirement list,
   not built to avoid scope creep this late.
6. **No OpenAPI/Swagger generation.** REST and MCP are documented by hand (`docs/rest-api.md`,
   `docs/mcp-server.md`) rather than through a generated spec. The architecture proposal listed OpenAPI
   as a proposed technology, not an assignment requirement.
7. **No frontend.** The assignment's own enumerated requirement list (reconstructed in the architecture
   plan's §2) does not include a web UI as a mandatory deliverable; the architecture plan's own executive
   summary proposed one as a later phase ("Next.js last, REST only" — `progress.md` "Decisions"). This
   milestone's brief explicitly excludes adding one. `apps/web` remains the next milestone after this one,
   not a missing requirement of this submission.
