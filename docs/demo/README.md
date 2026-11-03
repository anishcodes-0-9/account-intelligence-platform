# M7: MCP client demonstration

A reproducible, end-to-end demonstration of the Account Intelligence Platform through genuine MCP
clients, run against the real, running server (`pnpm mcp:http`) and a real Postgres database -- no REST
calls and no test framework stand in for any of this. Three client roles are involved (see "Clients
used" directly below) -- Claude Code only verifies the connection; the MCP TypeScript SDK's `Client` is
the one that actually executes the full workflow and concurrency demonstration.

## Clients used

Three distinct roles, kept deliberately separate so no one claim overstates what actually ran:

1. **Claude Code (this session)** verified that this environment *can* connect to the AIP server as an
   MCP client: `claude mcp add --transport http ...` plus `claude mcp list`/`claude mcp get` were actually
   run against the real, live server and both reported `Connected` (`00-claude-code-mcp-connection.txt`).
   This is real evidence that the connection, initialization and transport all work from Claude Code's own
   MCP-client machinery -- but it is **connection/configuration verification only**. Claude Code did
   **not** execute the end-to-end workflow or the concurrency demonstration below; driving individual tool
   calls live, inside this one conversation, would need either a human in an interactive terminal or a
   nested, non-interactive `claude -p` agent, and spawning that nested agent against this server is
   blocked by this sandbox's own policy ("Create Unsafe Agents" -- a safety control on the host running
   this session, unrelated to the AIP server itself). See "Manual screenshot capture" below for how a
   human can complete that specific part. The test config and its one-off API key were removed/revoked
   immediately after capturing this evidence (`claude mcp remove aip -s local`, `pnpm keys revoke`).
2. **MCP Inspector CLI** (`@modelcontextprotocol/inspector --cli`, the official Anthropic MCP debugging
   tool) is the **independent, third-party client** used for tool discovery and for probing
   authentication/scope failures from outside this codebase entirely (`01-tool-discovery.inspector.json`,
   `01b-inspector-auth-scope.txt`).
3. **The MCP TypeScript SDK's own `Client`** (`@modelcontextprotocol/client`'s `Client` +
   `StreamableHTTPClientTransport` -- the same client this project's own test suite already uses and
   `docs/mcp-server.md` documents as "tested against") is the client that actually drove **the complete
   end-to-end workflow and the bounded concurrency demonstration**, via a demo script
   (`apps/server/demo/mcp-client-demo.ts`, run as `pnpm --filter @aip/server demo:mcp`), with real,
   capturable, deterministic output. This is a real MCP client over real Streamable HTTP; it is not a
   test (no assertions gate it, and there is no throwaway database -- it runs against the same database
   the server itself is using) and it is not REST (it never calls `/api/*`, only `/mcp` and the
   `/downloads/:token` the server itself returns).

All three authenticate with real API keys created the same way `pnpm keys create`/`pnpm keys revoke`
already do (`ApiKeyService`), over the real Bearer-auth `/mcp` route from M5.

## What's in `evidence/`

All files are real, captured output from real runs against a locally seeded dev database -- nothing here
is invented.

| File | What it shows |
|---|---|
| `00-claude-code-mcp-connection.txt` | Real, actually-run output of `claude mcp add`/`list`/`get` against the live server: `aip: ... Connected`. Connection/configuration verification only -- see "Clients used" above. |
| `01-tool-discovery.inspector.json` | MCP Inspector CLI's `tools/list` against the live server: all five tools, their exact names and JSON Schema input shapes. |
| `01b-inspector-auth-scope.txt` | MCP Inspector CLI's own error output for a missing/garbage key (`tools/list`) and for a companies-only key calling `export_contacts`. See "A genuine client-side finding" below for why the scope case's output is a schema-validation error rather than a clean `FORBIDDEN`. |
| `02-connect-and-discover.json` | The SDK client's real `initialize` + `tools/list`, run with a freshly created, full-scope key: 5 tools discovered, each tool's name/title/description/inputSchema. |
| `03-auth-failures.json` | Four real connection attempts -- no `Authorization` header, a malformed key, a key that was allowed to actually expire (created with a 1.5s TTL, then used after sleeping past it), and a key revoked via `ApiKeyService.revoke` moments earlier -- all rejected identically (`401`/`UNAUTHENTICATED`), none echoing the key back. |
| `04-scope-forbidden.json` | A valid, unexpired, unrevoked key that only has `companies:read` calling `export_contacts`: `isError: true`, `structuredContent.error.code: "FORBIDDEN"`, enforced by `ContactService`/`requireScope` -- the identical scope rule REST and MCP both call. |
| `05-end-to-end-workflow.json` + `export.csv` | The full workflow below, with real seed-data ids and a real downloaded CSV -- includes one successful enrichment and one `PROVIDER_ERROR`, kept intentionally as error-handling evidence. |
| `05b-happy-path-workflow.json` + `happy-path-export.csv` | A separate, clean happy path: two seeded contacts whose enrichment outcome is deterministically `SUCCESS` (verified at runtime, not assumed), exported and downloaded, with real synthetic `email`/`linkedin` values present in both the JSON and the CSV. |
| `06-bounded-concurrency.json` | Six concurrent `get_company` calls for six different `companyId`s, bounded to 3 in flight at once by the demo script's own semaphore, with a start/end timestamp per call *and* a live sampler of the semaphore's actual in-flight counter proving real overlap, not just concurrent scheduling. |

Every `downloadUrl` saved to these files has its token replaced with `***redacted***` (download tokens
are credentials -- see "A note on download tokens" below); the demo script still uses the real,
unredacted URL to perform the actual download before redacting it for storage.

## End-to-end workflow (from `05-end-to-end-workflow.json`)

Run against the deterministic seed data (`packages/core/src/seed/data.ts`, 60 companies / 240 contacts,
3 of 12 industry slots are "Artificial Intelligence", and `Australia` is 3 of 10 country slots):

1. `search_companies({query: "Intelligence", country: "Australia"})` -> 6 results (companies whose
   industry/name/description contains "Intelligence" *and* whose country is Australia).
2. `get_company({companyId: "cmp_5"})` (the first result, "Brindle Labs") -> full company detail.
3. `search_contacts({companyId: "cmp_5"})` -> 4 contacts.
4. `enrich_contact` on the first two -> one `SUCCESS` (synthetic `email`/`linkedin`, `provenance[].synthetic: true`,
   `verified: false` -- never claimed as real data), one `PROVIDER_ERROR` (the mock provider's built-in
   deterministic failure case, handled the same way a real provider failure would be).
5. `export_contacts({contactIds: ["cnt_20", "cnt_18"]})` -> a `downloadUrl`, `rowCount: 2`.
6. `GET <downloadUrl>` (the exact URL the tool returned, no transformation) -> `200`, `text/csv`,
   header `id,name,title,email,linkedin`, 2 data rows -- row count matches the tool's own `rowCount`, and
   the failed enrichment's row correctly has empty `email`/`linkedin` rather than fabricated values.

## Clean happy path (from `05b-happy-path-workflow.json`)

The run above keeps a real `PROVIDER_ERROR` as useful error-handling evidence, but it means that run
alone never shows what a fully successful enrichment looks like end to end. This second run picks
`cnt_17` and `cnt_19` -- two of `cmp_5`'s own contacts whose outcome is deterministic from the mock
provider's own logic (`mockOutcomeFor` hashes the contact id; see
`packages/core/src/enrichment/mock-provider.ts`) -- and the script asserts `status === "SUCCESS"` and
that `email`/`linkedin` are both present *before* proceeding, throwing instead of continuing if that
assumption is ever wrong (e.g. if seed data changes). The provider itself is never modified to force
this:

1. `enrich_contact({contactId: "cnt_17"})` -> `SUCCESS`, synthetic `email`/`linkedin`.
2. `enrich_contact({contactId: "cnt_19"})` -> `SUCCESS`, synthetic `email`/`linkedin`.
3. `export_contacts({contactIds: ["cnt_17", "cnt_19"]})` -> `rowCount: 2`.
4. `GET <downloadUrl>` -> `200`, 2 data rows, and both rows' `email`/`linkedin` columns are verified
   non-empty (not just present-but-blank) before the script accepts the run as successful.

## Authentication and scope failures

`03-auth-failures.json` and `04-scope-forbidden.json` (above) are the authoritative evidence; see also
`01b-inspector-auth-scope.txt` for the same two failure classes from an independent, external client.

### A genuine client-side finding

MCP Inspector CLI's `tools/call` strictly validates a tool's result against that tool's declared
`outputSchema` before showing it. `export_contacts`'s `outputSchema` only describes the success shape
(`downloadUrl`/`exportId`/`expiresAt`/`rowCount`), so when the server correctly returns
`{isError: true, structuredContent: {error: {...}}}` for the companies-only key, Inspector rejects *that
response* as non-conforming and reports its own client-side validation error instead of relaying the
raw result. This is the same limitation already documented in `docs/mcp-server.md`'s "Validation error
shapes" section (the MCP SDK's `registerTool` has no option to describe an error shape alongside a
success `outputSchema`), observed here from the outside, through a different, independent client. It
does not mean the call succeeded -- no success data was returned either -- and the SDK client's own
direct, unvalidated `structuredContent` (`04-scope-forbidden.json`) shows the real `FORBIDDEN` result
underneath.

## Bounded parallel execution

`06-bounded-concurrency.json`'s timeline (also printed to stdout when the demo runs) shows six
`get_company` calls for `cmp_1`..`cmp_6`. These are safe to run concurrently because each reads a
different company row with no shared mutable state and no ordering dependency between them -- unlike,
say, two `export_contacts` calls racing to write the same row. Concurrency is **not** something MCP
itself provides: the demo script's own `Semaphore` class (a plain counter + wait queue, no dependency
added) is the orchestration layer that explicitly bounds how many calls are in flight, capped at 3.

Two independent kinds of evidence back this, both in `06-bounded-concurrency.json`:

- **Reconstructed overlap**: the `timelineMs` array's `startMs`/`endMs` per call (e.g. `cmp_4` starts
  before `cmp_1`..`cmp_3` have all finished) -- evidence that calls were still *running* concurrently,
  not just scheduled together.
- **Live-sampled overlap** (`liveSampler`): the semaphore's own `currentInFlight` counter polled roughly
  every 1ms for the whole run, which can only read `>= 2` or `3` at the instant it's read if that many
  calls are genuinely awaiting their network round trip at that exact moment -- this is a direct
  observation taken *during* execution, not something reconstructed afterwards from timestamps. A typical
  run takes on the order of 20-25 samples and finds roughly half of them sitting exactly at the limit of
  3; see `liveSampler.maxSampledInFlight`, `.samplesAtLimit` and `.samples` in the evidence file (and the
  "Max observed in-flight" / "Live sampler" lines printed when the demo runs) for the actual numbers from
  that run. The script also asserts `sem.maxObservedInFlight` never exceeds the configured limit and
  fails loudly if it ever does.

## A note on download tokens

`packages/core/src/exports/export-service.ts`'s `downloadUrl` embeds a single-use, time-limited
credential (the project's own logger already scrubs `/downloads/<token>` for exactly this reason -- see
`packages/core/src/logging/logger.ts`'s `DOWNLOAD_URL_PATTERN`). The demo script fetches the real,
unredacted URL to actually perform and verify each download, but every place that *prints* or *saves* a
`downloadUrl` -- console output and every evidence JSON file -- replaces the token with
`***redacted***` first (`redactDownloadUrl()` in `apps/server/demo/mcp-client-demo.ts`), so no committed
file or terminal transcript ever carries a usable download credential.

## Reproducing this demonstration

```bash
nvm use                                   # Node 24
pnpm install
cp .env.example .env
pnpm db:up && pnpm db:generate && pnpm db:migrate && pnpm db:seed

# Terminal 1: start the real server (serves /mcp, /api/*, /downloads/:token) -- leave this running
pnpm mcp:http

# Terminal 2: independent-client tool discovery and auth/scope probes (MCP Inspector CLI)
pnpm keys create --name inspector-demo --scopes companies:read,contacts:read,contacts:enrich,contacts:export
pnpm keys create --name inspector-demo-companies-only --scopes companies:read
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3001/mcp \
  --header "Authorization: Bearer <the full-scope key just created>" --method tools/list
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3001/mcp --method tools/list --stored-auth-only
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3001/mcp \
  --header "Authorization: Bearer <the companies-only key just created>" --method tools/call \
  --tool-name export_contacts --tool-args-json '{"contactIds":["cnt_1"]}'

# Terminal 2 (or a third): the full end-to-end workflow, happy path and bounded concurrency demo --
# one command, self-provisions its own demo API keys via the same ApiKeyService `pnpm keys` uses,
# writes docs/demo/evidence/*. This is the step the MCP SDK Client actually executes.
pnpm --filter @aip/server demo:mcp
```

An MCP client configuration example for a Streamable HTTP client (shape varies by client) is at
`mcp-client-config.example.json` in this directory; see `docs/mcp-server.md` for the stdio equivalent.

## Manual screenshot capture (not automated here)

No screenshots or recordings are included -- this environment has no display to capture from, and none
are fabricated. To capture real ones:

1. Open MCP Inspector's web UI (`npx @modelcontextprotocol/inspector`, no `--cli`), connect it to
   `http://127.0.0.1:3001/mcp` with a valid `Authorization: Bearer <key>` header, and screenshot its
   "Tools" tab (discovery) and a `tools/call` result panel (execution).
2. For Claude Code itself as a visible client: run `claude mcp add --transport http aip
   http://127.0.0.1:3001/mcp --header "Authorization: Bearer <key>"` in an interactive terminal, approve
   the server when prompted, start a normal (not `-p`) session in this repo, and screenshot a
   conversation where it calls `mcp__aip__search_companies` etc. -- this was not possible to automate
   inside this non-interactive session (see "Clients used" above).

## Limitations

- The literal scenario "use Claude Code as the MCP client" is demonstrated for connection *configuration*
  and *health-checking* (`claude mcp add`/`list`), confirming this environment can connect to the server,
  but not for live, interactive tool-calling inside this same session: that needs either a human in an
  interactive terminal or a nested non-interactive agent, which this sandbox's own policy blocks (not an
  AIP server limitation).
- MCP Inspector CLI's strict `outputSchema` validation means it cannot cleanly display an `isError` tool
  result whose shape differs from the declared success schema (see "A genuine client-side finding"
  above); the SDK client does not have this restriction.
- `enrich_contact`'s `PROVIDER_ERROR` case in the workflow is the mock provider's own deterministic
  failure behavior (see `packages/core/src/enrichment/mock-provider.ts`), not a defect introduced by this
  milestone.
