# 0001 - MCP SDK v2 compatibility spike (M1)

Date: 2026-11-03. Evidence: `apps/server/test/spike-*.test.ts` and Inspector CLI runs (see progress.md).

## Selected versions (exact)
| Package | Version |
|---|---|
| @modelcontextprotocol/server / client | 2.4.0 (npm `latest`) |
| @modelcontextprotocol/node | 2.1.2 |
| @modelcontextprotocol/fastify | 2.0.1 (peers: fastify ^5.2, server ^2.3) |
| fastify | 5.12.8 |
| zod | 4.6.7 (SDK needs ^4.2; import `zod/v4`) |
| Prisma CLI / @prisma/client / @prisma/adapter-pg | 7.10.1 |
| TypeScript | 6.0.3 |
| vitest 5.1.0, eslint 10.14.0, typescript-eslint 8.72.1, tsx 4.23.15 |

Spike was run on Node 26.7.0; from M2 the project uses Node 24.22.2 LTS (`.nvmrc`) and the full suite was re-run there. pnpm 10.33.0. Docker 29.9.1.

## Why not the "latest" tags
- `prisma@latest` is currently `8.0.0-rc.29` (a release candidate); we use the stable 7.10.1 line.
- `typescript@7.0.2` is outside typescript-eslint 8.72.1's peer range (`<6.1.0`), so TypeScript is pinned to 6.0.3.

## Verified behaviour (SDK 2.4.0)
- Tools: `server.registerTool(name, {inputSchema, outputSchema}, handler)` with `z.object(...)` schemas. `outputSchema` + `structuredContent` are returned and validated; a mismatch yields `isError: true` with an "Output validation error" message that names fields.
- Invalid input -> `isError: true` ("Input validation error"), handler not run.
- **A thrown `Error` is converted to `isError: true` whose text is the raw error message.** Internal details can leak. Handlers MUST catch everything and map to `AppError` -> safe messages.
- Returned `{isError: true, structuredContent}` reaches the client intact (our business-error channel).
- Unknown tool -> client call rejects with `ProtocolError` ("Tool x not found"), not an `isError` result.
- stdio: `serveStdio(() => server)` from `@modelcontextprotocol/server/stdio`; client uses `StdioClientTransport` from `@modelcontextprotocol/client/stdio`. Stdout stays protocol-only; clean exit when the client closes.
- HTTP: `createMcpHandler(factory)` + `toNodeHandler()` on a Fastify route from `createMcpFastifyApp()`. Stateless by default (fresh server per request, no session cleanup). `reply.hijack()` is needed because the adapter writes to `reply.raw`.
- Auth: the SDK never verifies tokens. We verify in a Fastify handler and set `request.raw.auth` (an `AuthInfo`); tool handlers read `ctx.http?.authInfo`. Verified end to end (`caller: "spike-key"`). Under stdio `ctx.http` is undefined, so the stdio principal must be injected via closure/factory, not `ctx.http`.
- Host/Origin: `createMcpFastifyApp({host: "127.0.0.1"})` rejects a bad Host or non-local Origin with 403 **before** our auth hook (a 403, not 401, with no credentials). A missing Origin is allowed.
- 401 handling: we return 401 + `WWW-Authenticate: Bearer`. MCP Inspector's CLI treats that as an OAuth trigger and stops with `auth_required` (non-interactive). Rejection is correct; the message is just OAuth-flavoured.
- Malformed JSON is rejected by Fastify before MCP (400, Fastify error shape, not JSON-RPC); wrong content type -> 415; valid JSON that is not JSON-RPC -> 400 JSON-RPC error.

## Limitations / deviations
- `@modelcontextprotocol/node` types `NodeIncomingMessageLike.method?: string`, incompatible with `exactOptionalPropertyTypes` when passed a real `IncomingMessage`. One narrow cast at the adapter boundary (`apps/server/src/spike/http-app.ts`); the compiler flag stays on.
- SDK `requireBearerAuth` assumes OAuth-style tokens (requires an `expiresAt`, verifier throws `OAuthError`), so API keys use a plain Fastify hook.
- (Resolved in M2 by moving to Node 24.) Prisma 7.10.1 printed an "unsupported Node.js" banner on Node 26 (its range is 20.19+/22.12+/24+). `validate`, `generate`, `db execute` and the client + adapter-pg runtime query all work. The risk is only upstream support policy; `engines` in the root package.json is `>=22.12`.
- Prisma 7 does not read `.env`; `packages/core/prisma.config.ts` loads the repo-root `.env` via `process.loadEnvFile`. Client is generated to `packages/core/src/generated/prisma` (git-ignored; run `pnpm db:generate`).
- Local Postgres already occupies 5432 on the dev machine, so Compose maps host port 5433.
- MCP Inspector's web UI was not exercised (needs a browser); the Inspector 2.13.0 CLI was, against both transports.
