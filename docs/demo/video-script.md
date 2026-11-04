# Demo video script (≤5 minutes)

A script for a screen recording, not a transcript of one that was recorded — this environment has no
display, so recording it is a manual step (see `docs/submission-checklist.md` §8). Every command and
every piece of data below is real: the same seeded data and the same commands used to produce
`docs/demo/evidence/`. Run `pnpm --filter @aip/server demo:mcp` live during the recording rather than
replaying saved JSON, so the audience sees real round trips happen.

Before recording: `pnpm db:up && pnpm db:migrate && pnpm db:seed`, then in one terminal `pnpm mcp:http`
(leave running), and in a second terminal run the commands below as you narrate. Create a demo key first:
`pnpm keys create --name demo --scopes companies:read,contacts:read,contacts:enrich,contacts:export`.

## 0:00–0:30 — Architecture and introduction

- Show `docs/architecture.md`'s Mermaid diagram rendered on GitHub (or in a Markdown previewer).
- Say: "Account Intelligence Platform — one Fastify backend exposing the same company/contact/enrichment/
  export logic through both an MCP server (stdio and Streamable HTTP) and a REST API. MCP is an interface
  to the application, not a separate implementation."

## 0:30–1:15 — MCP connection and discovery of five tools

- Run `npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3001/mcp --header "Authorization: Bearer <demo-key>" --method tools/list`
  (the real command behind `docs/demo/evidence/01-tool-discovery.inspector.json`).
- Point out all five tool names on screen: `search_companies`, `get_company`, `search_contacts`,
  `enrich_contact`, `export_contacts`, and one tool's full input schema.

## 1:15–2:30 — Company and contact search, details, enrichment

- Run `pnpm --filter @aip/server demo:mcp` and narrate over its live console output as it:
  - searches companies with `{query: "Intelligence", country: "Australia"}` — point out `Brindle Labs`
    (`cmp_5`) coming back first.
  - calls `get_company` for `cmp_5`.
  - calls `search_contacts` for `cmp_5` — four contacts, including `Grace Wright` (`cnt_18`).
  - calls `enrich_contact` for `cnt_18` — show the returned `email`/`linkedin` and point out
    `provenance[].synthetic: true`, `verified: false` on screen, and say explicitly: "this is synthetic
    fixture data, never claimed as externally verified."

## 2:30–3:15 — CSV export and actual download

- Let the same script run `export_contacts` for the enriched contact ids, then `fetch()` the returned
  download URL.
- Show the downloaded CSV content on screen (`id,name,title,email,linkedin` header, correct row count).
- Say: "the download token itself is the credential — it's never logged. The server only ever stores its
  hash."

## 3:15–4:00 — Authentication failure and scope enforcement

- Run `npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3001/mcp --method tools/list --stored-auth-only`
  with no `Authorization` header — show the real `401 UNAUTHENTICATED` HTTP-level rejection (auth fails
  before any MCP processing happens).
- Create (or reuse) a companies-only-scoped key and run
  `npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3001/mcp --header "Authorization: Bearer <companies-only key>" --method tools/call --tool-name export_contacts --tool-args-json '{"contactIds":["cnt_1"]}'`
  — show the real MCP `isError: true` result with `structuredContent.error.code: "FORBIDDEN"` (this is a
  per-call rejection inside a successful MCP session, not an HTTP 403 — the key is valid, just under-scoped).

## 4:00–4:40 — Bounded parallel execution

- Let the demo script's concurrency section run: six `get_company` calls across six companies, capped at
  3 concurrent in-flight requests by the script's own semaphore (not something MCP provides on its own).
- Show the printed timeline/overlap evidence (`docs/demo/evidence/06-bounded-concurrency.json`'s shape) —
  point out the observed max in-flight count never exceeds 3, and that overlapping windows are real
  (sampled from the running semaphore, not just scheduled concurrently).

## 4:40–5:00 — Architecture, documentation, closing

- Quick scroll through `README.md` and `docs/submission-checklist.md` showing requirement-to-evidence
  mapping.
- Close: "Everything shown here is reproducible with the commands in the README — nothing in this
  recording was staged beyond what's documented."

## Exact commands to have ready in a second terminal

```bash
pnpm db:up && pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm keys create --name demo --scopes companies:read,contacts:read,contacts:enrich,contacts:export
pnpm mcp:http &   # or a dedicated terminal
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3001/mcp \
  --header "Authorization: Bearer <demo-key>" --method tools/list
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3001/mcp --method tools/list --stored-auth-only
pnpm --filter @aip/server demo:mcp
```
