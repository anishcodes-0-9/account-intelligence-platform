# API keys, errors and logging

## Company search (CompanyService.search)
Text is split into lower-case alphanumeric tokens (`[\p{L}\p{N}]+`). Every meaningful query token must equal a whole token in the company's name, industry or description (different tokens may be satisfied by different fields). Filler terms `company companies inc ltd pty` are ignored; a non-blank query with nothing else is a VALIDATION_ERROR. Blank query/country = not provided. Country is an exact, case-insensitive match. Order: name, then id. `limit` defaults to 10 and must be 1..50 (out of range is a VALIDATION_ERROR, enforced by the shared contracts schema inside the service). PostgreSQL first narrows candidates by substring (a superset of token matches); tokens and the limit are applied afterwards in the service, so this is O(matching rows) per search, which is fine at this data size.

## Contact search (ContactService.search)
`companyId` and/or `jobTitle` (case-insensitive substring); at least one is required; blank strings count as absent; unknown `companyId` is NOT_FOUND; at most 100 results. DB `fullName`/`jobTitle` are returned as `name`/`title`.

## API keys
Format `aip_<keyId>_<secret>`: `keyId` is the ApiKey row id (cuid); the secret is 32 random bytes (base64url, 43 chars) from `crypto.randomBytes`. Only `sha256(secret)` is stored; the raw key is returned once by `create`. `verify` parses the key, loads the row by id, hashes the presented secret (against a dummy hash when the id is unknown) and compares with `timingSafeEqual`, then rejects revoked or expired keys. Every failure returns the same UNAUTHENTICATED message. `lastUsedAt` is written at most once per minute. Missing scope is FORBIDDEN, checked in each service method before input validation. This is the assignment's API-key option, not an OAuth 2.1 authorization server.

CLI: `pnpm keys create|list|revoke` (see CLAUDE.md). `list` prints metadata only.

## Errors
`AppError` subclasses carry a code from `@aip/contracts` (VALIDATION_ERROR, NOT_FOUND, UNAUTHENTICATED, FORBIDDEN, PROVIDER_ERROR, EXPORT_LIMIT, INTERNAL). `mapError(error, logger, context)` returns `{ httpStatus, body: { error: { code, message } } }`: AppErrors keep their message; everything else (and INTERNAL) becomes the generic "An internal error occurred." and is logged in full. The MCP SDK returns a thrown error's message to clients, so MCP tool handlers must wrap their body and call `mapError` (done in M5).

## Logging
`createLogger()` (Pino, JSON). Redacts authorization/cookie headers, api keys, tokens, secrets, hashes, download URLs and contact personal data (email, linkedin, names) at common paths, and scrubs raw API keys and bearer tokens that appear inside any string. Log `contactId`s, not contact data. `stderrDestination()` is for stdio MCP, where stdout is protocol-only. Limitation: redaction is path-based (two wildcard levels) plus the string scrub, so new field names holding secrets must be added to `REDACT_PATHS`.
