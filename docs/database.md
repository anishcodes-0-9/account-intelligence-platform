# Database

PostgreSQL 17 (Docker Compose, host port 5433) via Prisma 7.10.1 with the `@prisma/adapter-pg` driver adapter.
Schema: `packages/core/prisma/schema.prisma`. Migrations: `packages/core/prisma/migrations/`.

| Table | Purpose | Notes |
|---|---|---|
| companies | Company records | ids `cmp_<n>`; indexes on country, industry, employees; CHECK employees >= 0 |
| contacts | Contacts, each belongs to one company | ids `cnt_<n>`; FK `companyId` ON DELETE RESTRICT; indexes on companyId, jobTitle; `email`/`linkedin` nullable, filled by enrichment |
| enrichment_records | One row per enrichment attempt | FK contact ON DELETE CASCADE; `status` enum SUCCESS/PARTIAL/NOT_FOUND/FAILED; `returned` and `provenance` JSONB; index (contactId, createdAt) |
| api_keys | Hashed API keys | `keyHash` unique; `scopes text[]`; expiry/revocation/last-use timestamps. Raw keys are never stored |
| export_jobs | CSV exports | CSV in `content` (TEXT); `tokenHash` unique (download token hash only); FK apiKey ON DELETE RESTRICT; index on expiresAt for purging; CHECKs rowCount >= 0 and non-empty contactIds |

CHECK constraints are appended by hand to the init migration (Prisma's schema language cannot express them). `prisma migrate status` does not see them, and `prisma migrate dev` will not remove them.

Wire-name mapping (done in later milestones, not in the database): `Company.employees` -> `employees`, `Contact.fullName` -> `name`, `Contact.jobTitle` -> `title`, `Contact.linkedin` -> `linkedin`.

## Seed
`pnpm db:seed` (`packages/core/src/seed`). Deterministic and idempotent: upserts by id, never deletes. 60 companies and 240 contacts (4 per company), synthetic names, websites on the reserved `.example` TLD, no emails or LinkedIn URLs. Contact upserts only write seed-owned fields, so enrichment results survive a re-seed. A changed seed definition updates rows in place.

## Tests
`pnpm test` creates a template database from the real migrations (global setup), and every DB test file clones it, so tests are isolated, parallel-safe and independent of the dev database. Requires `pnpm db:up` and `pnpm db:generate`.
