# MCP server (M5)

A real MCP server exposing the five product tools over both the stdio and Streamable HTTP transports,
backed by the same `@aip/core` services as the rest of the platform.

## Architecture

```
apps/server/src/mcp/
  services.ts        buildServices(): wires repositories + CompanyService, ContactService,
                      EnrichmentService, ExportService, ApiKeyService from one PrismaClient
  register-tools.ts   registerTools(): the five tools, their Zod schemas (from @aip/contracts) and
                      error handling -- the single place tool logic is defined
  create-server.ts     createAipMcpServer(): builds one McpServer and calls registerTools()
  http-app.ts         Fastify /mcp route: Bearer auth, Host/Origin checks, Streamable HTTP wiring
apps/server/src/bin/
  mcp-stdio.ts        stdio entry point
  mcp-http.ts         HTTP entry point (/mcp, /api/*, /downloads/:token -- see below and docs/rest-api.md)
```

Since M6, `mcp-http.ts` serves more than `/mcp`: `apps/server/src/http-app.ts`'s `buildHttpApp()` wraps
`buildMcpHttpApp()` (unchanged from M5) and additionally mounts the REST API and CSV download route on
the exact same Fastify instance and port, so the URL `export_contacts` returns resolves against the
same running server. Details: `docs/rest-api.md`.

`registerTools()` is called by both entry points with the same `McpServices` bundle, so stdio and HTTP
run identical tool definitions, schemas and business logic -- only how the caller's principal is
resolved differs (see "Authentication" below). `packages/core` has no dependency on the MCP SDK or
Fastify; the `mcp/` directory is the only place that imports `@modelcontextprotocol/*`.

## The five tools

| Tool | Scope required | Input | Output |
|---|---|---|---|
| `search_companies` | `companies:read` | `{query?, country?, limit?}` | `{results: [{id, name, industry, employees}]}` |
| `get_company` | `companies:read` | `{companyId}` | `{id, name, website, industry, employees, description, country}` |
| `search_contacts` | `contacts:read` | `{companyId?, jobTitle?}` (at least one required) | `{contacts: [{id, name, title}]}` |
| `enrich_contact` | `contacts:enrich` | `{contactId}` | `{email, linkedin, status, provider, provenance}` |
| `export_contacts` | `contacts:export` | `{contactIds: [...]}` (max 200) | `{downloadUrl, exportId, expiresAt, rowCount}` |

Every input/output schema comes straight from `@aip/contracts`; it is never redefined in the MCP layer.
`enrich_contact` results are always synthetic fixtures (`provenance[].synthetic: true`, `verified: false`
-- see `docs/enrichment-and-export.md`); nothing here claims real-world verified data.

A failure (validation, not-found, forbidden, provider error, export limit) is returned as
`{isError: true, structuredContent: {error: {code, message}}}`, built by the same `mapError()` every
other transport uses -- a tool handler never lets a raw `Error` reach the SDK (which would otherwise
echo its message verbatim to the client, per the M1 spike finding in `docs/decisions/0001`).

## Authentication and scopes

Both transports authenticate through the real `ApiKeyService` (`aip_<keyId>_<secret>`, SHA-256 hash
comparison, expiry and revocation checks -- unchanged from M3/M4). Neither transport trusts anything the
MCP client itself supplies as identity.

- **stdio**: the API key is read once from the `AIP_API_KEY` environment variable at process startup and
  verified before the server starts serving. An invalid, expired, revoked or missing key makes the
  process exit(1) immediately, writing nothing to stdout and no credential to stderr. The resulting
  principal is fixed for the lifetime of that one process/connection and injected into every tool call
  via closure -- there is no per-request identity to keep separate under stdio, so nothing mutable is
  shared between sessions.
- **HTTP**: a Fastify `preHandler`-style check on `/mcp` reads the `Authorization: Bearer <key>` header,
  calls `ApiKeyService.verify`, and on success attaches the verified principal to the request as the
  MCP SDK's own `AuthInfo` (`request.raw.auth`), carried in `AuthInfo.extra` -- a channel the SDK passes
  through to tool handlers (`ctx.http.authInfo`) and never derives from client input itself. On failure
  it returns `401` with `WWW-Authenticate: Bearer` before any MCP processing happens. `createMcpFastifyApp`
  also rejects a bad `Host` or non-local `Origin` with `403`, before auth even runs (verified in the M1
  spike).

Each tool's required scope (table above) is enforced by the service itself (`requireScope`), exactly as
in REST -- a missing scope throws `ForbiddenError`, mapped to an `isError` result with `code: FORBIDDEN`.
This means a session authenticated with a valid key can still have individual tool calls rejected if
that key lacks the scope for that specific tool.

### Validation error shapes

There are two distinct kinds of tool-input rejection, and they intentionally produce two different
shapes:

- **A raw shape violation** (missing a required field, wrong type) is rejected by the MCP SDK's own
  schema validation, before our tool handler ever runs. This returns `{isError: true, content: [...]}`
  with **no `structuredContent`** -- the SDK's message text (e.g. `"Input validation error: ..."`) is
  all that's available.
- **A business-rule violation that passes the raw shape** (e.g. `search_contacts` with neither
  `companyId` nor `jobTitle`, which the schema allows since both are optional) is rejected by the
  service's own `ValidationError`, caught by `fail()` (`register-tools.ts`), which always returns
  `{isError: true, structuredContent: {error: {code, message}}}`.

This was investigated as part of the M5 review and found to have no clean fix: `registerTool`'s config
object (`title`/`description`/`inputSchema`/`outputSchema`/`annotations`/`icons`/`scopeChallenge`/`_meta`)
has no option to keep schema-based validation and discovery while customizing the shape of its own
rejection. The only way to make the two shapes identical would be to stop passing `inputSchema` to
`registerTool` and re-validate everything ourselves inside the handler -- which would also drop the
schema from `tools/list`, breaking client-side discovery and the cross-transport parity this project
relies on (`mcp-parity.test.ts`). That trade is worse than the inconsistency it would remove, so this is
accepted and documented rather than worked around. A client that needs a `code` for every rejection
should treat the *absence* of `structuredContent` on an `isError` result as itself meaning "the SDK
rejected the raw shape" -- a reasonable fallback, and the one `mcp-stdio.test.ts`'s
"documents the one real difference in error shape" test locks in as a regression guard.

## Running the servers

```bash
# stdio (reads AIP_API_KEY from the environment; create one with `pnpm keys create`)
AIP_API_KEY=aip_... pnpm mcp:stdio

# Streamable HTTP, served at http://<HOST>:<PORT>/mcp
pnpm mcp:http
```

Both read the same `.env` (`DATABASE_URL`, `HOST`, `PORT`, `LOG_LEVEL`, `DOWNLOAD_BASE_URL`) as the rest
of the project. `DOWNLOAD_BASE_URL` is the origin `export_contacts` builds its download URL on; it
defaults to `http://<HOST>:<PORT>` if unset (the `/downloads/:token` route itself lands in M6).

### Creating an API key

```bash
pnpm keys create --name my-mcp-client --scopes companies:read,contacts:read,contacts:enrich,contacts:export
```

The raw key is printed once; store it as `AIP_API_KEY` for stdio, or use it as the Bearer token for HTTP.

### Example MCP client configuration

Any MCP-compatible client that supports a stdio or Streamable HTTP server can connect. For a
stdio-launching client (configuration shape varies by client; this is the command/args/env it needs):

```json
{
  "mcpServers": {
    "aip": {
      "command": "pnpm",
      "args": ["--filter", "@aip/server", "mcp:stdio"],
      "env": { "AIP_API_KEY": "aip_..." }
    }
  }
}
```

For an HTTP-based client, point it at `http://127.0.0.1:3001/mcp` with header
`Authorization: Bearer aip_...`.

This has been tested against the MCP TypeScript SDK's own `Client`/`StdioClientTransport`/
`StreamableHTTPClientTransport` (see "Testing" below); it has not been tested against MCP Inspector's
UI or any other third-party client, so no compatibility claim is made beyond the SDK client itself.

## Testing

`apps/server/test/mcp-stdio.test.ts`, `mcp-http.test.ts` and `mcp-parity.test.ts` are real,
protocol-level tests: a real MCP SDK client connects to the real stdio binary (spawned as its own
`tsx` process) or the real Fastify `/mcp` route, against a real, migrated, isolated Postgres database
(the same `createIsolatedDb`/`seedDatabase` infrastructure the rest of the project's integration tests
use). No service method is called directly from these files.

Covered: tool discovery (all five, both transports), successful execution of all five tools, unknown
company/contact ids, invalid tool arguments, missing/invalid/expired/revoked credentials, insufficient
scope (`FORBIDDEN`), a usable `export_contacts` download URL, cross-transport parity for identical
inputs, and that stderr/log output never contains an API key, Authorization header or download URL.

A post-review hardening round added:

- `mcp-http-concurrency.test.ts`: two independently-connected clients, two different keys with
  different scopes, 25 rounds of deliberately interleaved concurrent `export_contacts` calls. Asserts
  the full-scope key's calls always succeed and the companies-only key's calls are always `FORBIDDEN`
  (never flipped), and cross-checks at the database level that every created `ExportJob` row was
  authored by the full-scope key's `keyId` -- never the other key's.
- `mcp-http-revocation.test.ts`: connects one client, successfully calls a tool, revokes that exact key
  via the real `ApiKeyService`, then reuses the *same, never-reconnected* client/session for another
  call and confirms it is rejected (`401 UNAUTHENTICATED`, key never echoed) -- proving the key is
  re-verified on every request, not cached from the initial connection.
- `mcp-http-security.test.ts`: Host-header (DNS rebinding) and Origin rejection, malformed JSON, and
  wrong Content-Type, against the real `buildMcpHttpApp()` -- ported from the deleted M1 spike suite so
  this coverage survives the spike's removal. No custom middleware was added; this only proves
  `createMcpFastifyApp`'s and Fastify's own protections are still in effect.
- `mcp-stdio.test.ts` ("stdout/stderr hygiene on the success path"): the SDK's `StdioClientTransport`
  does not expose the child process's raw stdout for inspection (only `.stderr`), so this test spawns the
  real binary directly and drives one real tool call with hand-written, minimal, spec-correct JSON-RPC
  frames over stdin -- every actual tool/auth/service code path still runs for real; only the
  client-side framing is hand-written, because there is no SDK-supported way to both use the official
  `Client` and inspect the raw byte stream it owns. It asserts every stdout line parses as JSON-RPC and
  that the server's own "ready" diagnostic appears only on stderr.

```bash
pnpm test                                        # full suite, including the above
pnpm exec vitest run apps/server/test/mcp-stdio.test.ts
pnpm exec vitest run apps/server/test/mcp-http.test.ts
pnpm exec vitest run apps/server/test/mcp-parity.test.ts
pnpm exec vitest run apps/server/test/mcp-http-concurrency.test.ts
pnpm exec vitest run apps/server/test/mcp-http-revocation.test.ts
pnpm exec vitest run apps/server/test/mcp-http-security.test.ts
```

## What was removed

The M1 spike (`apps/server/src/spike/*`, its tests, and `SPIKE_API_KEY`) is deleted now that the real
implementation replaces it. Its SDK findings remain documented in `docs/decisions/0001-mcp-sdk-v2-spike.md`
(still accurate for SDK 2.4.0) since this milestone relied on them directly.

## Known limitations / deferred

- No MCP `resources` or `prompts` are exposed, only `tools` -- out of scope for this assignment.
- Compatibility is demonstrated only against the MCP TypeScript SDK's own client, not against MCP
  Inspector or other third-party clients.
