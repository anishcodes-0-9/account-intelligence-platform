# Account Intelligence Platform (AIP)

An MCP server (stdio + Streamable HTTP) exposing company/contact intelligence tools, plus a REST API
serving the same core logic. Full architecture, standards and workflow rules: [CLAUDE.md](CLAUDE.md).
Milestone history and current status: [progress.md](progress.md).

## Setup

Node 24 is required.

```bash
nvm use                        # reads .nvmrc (24.22.2)
pnpm install
cp .env.example .env
pnpm db:up                     # Postgres 17 on host port 5433
pnpm db:generate                # Prisma client (git-ignored; regenerate after a fresh clone)
pnpm db:migrate
pnpm db:seed                    # 60 companies / 240 contacts of deterministic synthetic data
```

```bash
pnpm typecheck
pnpm lint
pnpm test                       # integration tests build their own throwaway databases
```

## Running the server

```bash
pnpm keys create --name my-key --scopes companies:read,contacts:read,contacts:enrich,contacts:export
pnpm mcp:http                   # serves /mcp, /api/*, /downloads/:token on one port (see .env)
# or, for a stdio MCP client:
AIP_API_KEY=<key> pnpm mcp:stdio
```

Details: [docs/mcp-server.md](docs/mcp-server.md) (MCP tools, auth, transports) and
[docs/rest-api.md](docs/rest-api.md) (REST endpoints, auth, response envelopes).

## MCP client demonstration

[docs/demo/](docs/demo/) has a full, reproducible demonstration of the platform through real MCP
clients: tool discovery, authenticated execution, authentication/scope failures, a real end-to-end
search -> enrich -> export -> download workflow with a verified CSV, and a bounded-concurrency example.
One command reproduces most of it once the server above is running:

```bash
pnpm --filter @aip/server demo:mcp
```

## Status

M1-M6 are committed and merged. M7 (this MCP client demonstration) is implemented and awaiting review.
See [progress.md](progress.md) for what each milestone delivered and what's deferred. No frontend yet
(`apps/web`, REST-only, is the next milestone after M7 is approved).
