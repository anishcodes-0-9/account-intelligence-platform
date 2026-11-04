# Account Intelligence Platform (AIP)

A company and contact intelligence platform with an MCP server (stdio + Streamable HTTP) exposing five
tools — `search_companies`, `get_company`, `search_contacts`, `enrich_contact`, `export_contacts` — plus
a REST API serving the exact same application logic, backed by PostgreSQL via Prisma. MCP is treated as
an interface to the application, not a second implementation of business rules: REST and MCP tools call
the same services.

Full architecture, standards and workflow rules: [CLAUDE.md](CLAUDE.md). Milestone history and current
status: [progress.md](progress.md). Requirement-by-requirement coverage with evidence file paths:
[docs/submission-checklist.md](docs/submission-checklist.md).

## Architecture summary

`packages/contracts` (Zod schemas, exact field names) <- `packages/core` (services, repositories, auth,
errors, logging — no dependency on Fastify or the MCP SDK) <- `apps/server` (Fastify REST routes, the
`/mcp` Streamable HTTP endpoint, and a stdio binary). `apps/web` (not yet built) will talk to the REST
API only. One shared `registerTools()` call defines the five MCP tools once, used identically by both
transports. Full diagram and explanation: [docs/architecture.md](docs/architecture.md) (Mermaid, renders
on GitHub).

## Prerequisites

- Node 24 (`.nvmrc` pins `24.22.2`; run `nvm use`)
- Docker (for local PostgreSQL via Docker Compose)
- pnpm (via Corepack, or `npm i -g pnpm`)

## Environment configuration

```bash
cp .env.example .env
```

`.env.example` has placeholder values only — see its comments for what each variable controls
(database URL, HTTP host/port, download base URL). Never commit a real `.env`.

## Setup, database, migration, seeding

```bash
nvm use
pnpm install
pnpm db:up           # Postgres 17 on host port 5433 (docker compose)
pnpm db:generate      # Prisma client — git-ignored, regenerate after a fresh clone or schema change
pnpm db:migrate
pnpm db:seed          # 60 companies / 240 contacts, deterministic, safe to rerun
```

```bash
pnpm typecheck
pnpm lint
pnpm test             # integration tests build their own throwaway databases, never touch the dev DB
```

## Running the servers

```bash
pnpm keys create --name my-key --scopes companies:read,contacts:read,contacts:enrich,contacts:export
pnpm mcp:http                   # serves /mcp, /api/*, /downloads/:token on one port (see .env)
```

### Running the stdio MCP server

```bash
AIP_API_KEY=<key> pnpm mcp:stdio
```

Intended for local MCP clients (e.g. Claude Code) that spawn a child process rather than connecting over
HTTP. stdout carries protocol messages only; diagnostics go to stderr.

## API authentication and scopes

Every request — MCP or REST — authenticates with an API key (`aip_<keyId>_<secret>`, hashed with SHA-256,
never stored or logged raw) sent as `Authorization: Bearer <key>`. Each operation requires one of four
scopes: `companies:read`, `contacts:read`, `contacts:enrich`, `contacts:export`. Missing, invalid,
expired or revoked keys are rejected before any processing (`401`); a valid key lacking the required
scope is rejected per-call (`403`/MCP `FORBIDDEN`). Key management:
`pnpm keys create|list|revoke`. Full detail: [docs/api-keys-and-errors.md](docs/api-keys-and-errors.md).

## The five MCP tools

| Tool | Scope | Example input | Example output (abridged) |
|---|---|---|---|
| `search_companies` | `companies:read` | `{"query": "Intelligence", "country": "Australia"}` | `{"results": [{"id": "cmp_5", "name": "Brindle Labs", "industry": "Artificial Intelligence", "employees": 6505}, ...]}` |
| `get_company` | `companies:read` | `{"companyId": "cmp_5"}` | `{"id": "cmp_5", "name": "Brindle Labs", "website": "https://brindlelabs.example", "industry": "Artificial Intelligence", "employees": 6505, "country": "Australia", "description": "..."}` |
| `search_contacts` | `contacts:read` | `{"companyId": "cmp_5"}` | `{"contacts": [{"id": "cnt_18", "name": "Grace Wright", "title": "Head of Data"}, ...]}` |
| `enrich_contact` | `contacts:enrich` | `{"contactId": "cnt_18"}` | `{"email": "grace.wright@brindlelabs.example", "linkedin": "https://linkedin.example/in/synthetic-grace-wright-cnt-18", "status": "SUCCESS", "provider": "mock-synthetic", "provenance": [{"field": "email", "synthetic": true, "verified": false, ...}]}` |
| `export_contacts` | `contacts:export` | `{"contactIds": ["cnt_18", "cnt_20"]}` | `{"downloadUrl": "http://127.0.0.1:3001/downloads/<token>", "exportId": "...", "rowCount": 2, "expiresAt": "..."}` |

These are real, captured outputs — see `docs/demo/evidence/05-end-to-end-workflow.json` and
`05b-happy-path-workflow.json` for the full, unabridged run. Full schema/error-shape detail:
[docs/mcp-server.md](docs/mcp-server.md).

## REST API

Five endpoints mirroring the MCP tools exactly (same services, same scopes, same validation):
`GET /api/companies`, `GET /api/companies/:companyId`, `GET /api/contacts`,
`POST /api/contacts/:contactId/enrich`, `POST /api/contacts/export`. Full endpoint docs, request/response
shapes and error codes: [docs/rest-api.md](docs/rest-api.md).

## CSV export and download

`export_contacts` / `POST /api/contacts/export` generate an RFC-4180 CSV (formula-injection-safe),
store it, and return a `downloadUrl` carrying a random token — only its SHA-256 hash is persisted, and
the URL expires after 15 minutes. `GET /downloads/:token` is the only way to retrieve the file; unknown,
malformed and expired tokens all return the same `404`. Download tokens are credentials and are never
logged. Detail: [docs/enrichment-and-export.md](docs/enrichment-and-export.md).

## MCP client configuration example

```json
{
  "mcpServers": {
    "aip": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": { "Authorization": "Bearer aip_<keyId>_<secret>" }
    }
  }
}
```

Full example file: [docs/demo/mcp-client-config.example.json](docs/demo/mcp-client-config.example.json).
stdio equivalent (env-based, no HTTP headers): [docs/mcp-server.md](docs/mcp-server.md).

## Testing

```bash
pnpm typecheck
pnpm lint
pnpm test             # 262 tests: unit, integration (real Postgres), protocol-level MCP, REST, parity
```

## MCP client demonstration

[docs/demo/](docs/demo/) has a full, reproducible demonstration of the platform through real MCP
clients: tool discovery, authenticated execution, authentication/scope failures, a real end-to-end
search -> enrich -> export -> download workflow with a verified CSV, and a bounded-concurrency example.
One command reproduces most of it once the server above is running:

```bash
pnpm --filter @aip/server demo:mcp
```

A ≤5-minute demo video script with exact commands: [docs/demo/video-script.md](docs/demo/video-script.md).

## Limitations

- **Synthetic enrichment data only.** `enrich_contact` is backed by a deterministic mock provider; every
  returned field is marked `synthetic: true` / `verified: false` and is never claimed as real, externally
  verified contact information. No LinkedIn scraping, no real third-party enrichment API.
- **No frontend yet.** `apps/web` (Next.js, REST-only) is the next milestone, not part of this submission.
- **No rate limiting or health-check endpoint.** Proposed in the original architecture plan, not built —
  not required to meet the assignment's non-functional bar, which this project already exceeds with
  error handling, validation, logging, type safety, documentation and clean architecture. See
  [docs/submission-checklist.md](docs/submission-checklist.md) §8 for the full, explicit gap list.
- **No OAuth.** API-key authentication was the chosen, documented path (the assignment permits either).
- **Claude Code's role in the M7 demonstration is connection/health-check verification only**
  (`claude mcp add/list/get` against the real running server); the full tool-calling workflow and
  concurrency demo were driven by the MCP TypeScript SDK's own client, for a sandbox-policy reason
  documented in [docs/demo/README.md](docs/demo/README.md).
- REST has only been tested against Node's own `http` client — no browser/CORS testing yet, since
  `apps/web` doesn't exist.

## Status

M1–M7 are committed and pushed. M8 (this submission package: requirement audit, architecture diagram,
demo video script, final documentation pass) is in progress. See
[progress.md](progress.md) for what each milestone delivered.
