# REST API and CSV downloads (M6)

The REST API and `GET /downloads/:token` are served from the same Fastify app as the MCP Streamable
HTTP transport (`/mcp`, M5) -- one process, one host/port. REST route handlers call the exact same
`@aip/core` services MCP tools call (`apps/server/src/mcp/register-tools.ts`); no business rule is
duplicated.

```
apps/server/src/
  http-app.ts           buildHttpApp(): one Fastify instance serving /mcp, /api/*, /downloads/:token
  rest/
    auth.ts             requireApiKey(): Bearer auth preHandler, reusing ApiKeyService unchanged
    routes.ts            the five REST endpoints -- parse -> call service -> map result/error
    downloads.ts          GET /downloads/:token -> ExportService.download
```

## Endpoints

| Method | Path | Scope required | Input | Success |
|---|---|---|---|---|
| `GET` | `/api/companies` | `companies:read` | query: `query?`, `country?`, `limit?` | `200 {results: [...]}` |
| `GET` | `/api/companies/:companyId` | `companies:read` | path: `companyId` | `200 {id, name, website, industry, employees, description, country}` |
| `GET` | `/api/contacts` | `contacts:read` | query: `companyId?`, `jobTitle?` (at least one) | `200 {contacts: [...]}` |
| `POST` | `/api/contacts/:contactId/enrich` | `contacts:enrich` | path: `contactId` | `200 {email, linkedin, status, provider, provenance}` |
| `POST` | `/api/contacts/export` | `contacts:export` | JSON body: `{contactIds: [...]}` (max 200) | `200 {downloadUrl, exportId, expiresAt, rowCount}` |
| `GET` | `/downloads/:token` | none (the token is the credential) | path: `token` | `200`, `text/csv` body |

Every input/output shape comes from `@aip/contracts` -- the same schemas MCP uses. `GET` endpoints take
their input from the query string (query params are strings; `limit` is coerced to a number before
validation, so a non-numeric `limit` fails as `VALIDATION_ERROR` rather than crashing).

## Authentication and scopes

Identical to MCP (`docs/mcp-server.md` "Authentication and scopes"): every `/api/*` route requires
`Authorization: Bearer <key>`, verified by the same `ApiKeyService.verify` MCP's HTTP transport calls,
on every request (no caching). A missing/invalid/expired/revoked key returns `401` with
`WWW-Authenticate: Bearer` before any service code runs; the key is never echoed back. Each route's
required scope (table above) is enforced by the service itself (`requireScope`), not the route handler --
exactly as MCP -- so `403 FORBIDDEN` is a service-level outcome, not route-level logic duplicated from MCP.

`GET /downloads/:token` takes no Authorization header: the download token itself (32 random bytes,
only its SHA-256 stored) is the credential, as it already was for M4/M5. Unknown, malformed and expired
tokens all produce the exact same `404 NOT_FOUND` body (`ExportService.download`'s single code path),
so a client cannot distinguish "never existed" from "existed and expired" from "garbage input."

## REST vs. MCP response envelope

Both transports call the same service and get the same data back; only the envelope differs:

- **REST success**: the service's return value is the JSON body directly, with the real HTTP status
  (`200`). There is no wrapper.
- **MCP success**: `{content: [{type: "text", text: "<JSON>"}], structuredContent: <same data>}`, always
  at HTTP status `200` for `/mcp` itself, per the MCP transport's own protocol.
- **Errors, both transports**: the identical `{error: {code, message}}` body from `mapError()`. REST
  sets the real HTTP status for that code (`400`/`401`/`403`/`404`/`422`/`502`/`500`, see
  `packages/core/src/errors/map-error.ts`); MCP returns `isError: true` with `structuredContent: {error}}`
  and the JSON-RPC/HTTP status stays `200`, since the SDK transport -- not the tool result -- owns that
  status code.

One intentional REST-only exception: a POST body that fails JSON parsing or omits a required field is
rejected as a `VALIDATION_ERROR`/`400` the same way an equivalent MCP tool argument failure would be,
through the identical `ValidationError`/`mapError` path -- there is no separate REST-only error shape.

## Request examples

```bash
# Search companies
curl -H "Authorization: Bearer aip_..." "http://127.0.0.1:3001/api/companies?query=cloud&limit=5"

# Get one company
curl -H "Authorization: Bearer aip_..." http://127.0.0.1:3001/api/companies/cmp_1

# Search contacts
curl -H "Authorization: Bearer aip_..." "http://127.0.0.1:3001/api/contacts?companyId=cmp_1"

# Enrich a contact
curl -X POST -H "Authorization: Bearer aip_..." http://127.0.0.1:3001/api/contacts/cnt_1/enrich

# Export contacts
curl -X POST -H "Authorization: Bearer aip_..." -H "Content-Type: application/json" \
  -d '{"contactIds": ["cnt_1", "cnt_2"]}' http://127.0.0.1:3001/api/contacts/export

# Download the resulting CSV (no Authorization header -- the token is the credential)
curl http://127.0.0.1:3001/downloads/<token>
```

## Error responses

```json
{ "error": { "code": "NOT_FOUND", "message": "Company not found: cmp_nope" } }
```

`code` is one of `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `UNAUTHENTICATED` (401), `FORBIDDEN` (403),
`PROVIDER_ERROR` (502), `EXPORT_LIMIT` (422), `INTERNAL` (500) -- see `map-error.ts`. `INTERNAL` never
includes the real error detail; it is logged server-side only.

## Testing

`apps/server/test/rest-api.test.ts`, `downloads.test.ts` and `rest-mcp-parity.test.ts` are real,
protocol-level integration tests: a real Node `http.request` client against the real Fastify app
(`buildHttpApp`), against a real, migrated, isolated Postgres database -- no service method is called
directly except in the one controlled-clock sub-test described below.

Covered: all five REST operations succeeding; missing, invalid, expired and revoked API keys (`401`,
credential never echoed); insufficient scope (`403 FORBIDDEN`); validation failures (bad `limit`,
neither `companyId` nor `jobTitle`, malformed JSON body) and missing records (`404 NOT_FOUND`);
successful CSV download with correct `Content-Type`/`Content-Disposition` and row count; unknown and
malformed download tokens returning byte-identical `404` bodies; and that REST and MCP return identical
`structuredContent`/JSON-body data for the same query, and identical `FORBIDDEN` enforcement for the
same under-scoped key.

The expired-token case in `downloads.test.ts` cannot wait on the real 15-minute TTL, so it builds a
second, standalone Fastify app wired to the same database but with an `ExportService` given a
controllable `now()` (the same injection point `packages/core/test/export-service.test.ts` already uses
at the service level) -- the clock is only faked for that one sub-test; everything else in this file
runs against the real server with the real clock.

```bash
pnpm exec vitest run apps/server/test/rest-api.test.ts
pnpm exec vitest run apps/server/test/downloads.test.ts
pnpm exec vitest run apps/server/test/rest-mcp-parity.test.ts
```
