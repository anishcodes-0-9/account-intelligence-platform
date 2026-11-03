export const CENSOR = "[REDACTED]";

/**
 * Credential-shaped `key = value` / `key: value` assignments, matched case-insensitively. Also catches
 * the query-string form (`?access_token=...`) since `=` is one of the separators. Deliberately a fixed,
 * short list of known-sensitive names rather than a generic secret scanner.
 */
const CREDENTIAL_ASSIGNMENT_KEYS = ["access_token", "refresh_token", "api[_-]?key", "password", "secret", "token", "key", "credential"];

/**
 * The one place every secret-shaped pattern lives. Both provider-error persistence
 * (`enrichment/sanitize-error.ts`) and application logging (`logging/logger.ts`, `errors/map-error.ts`)
 * redact through this function, so there is a single source of truth for what counts as a secret.
 *
 * Order matters: broader patterns run first so a later, narrower pattern cannot re-expose part of a
 * match a redaction already replaced (e.g. "Authorization: Bearer x" is fully handled by the
 * Authorization pattern before the standalone Bearer pattern would otherwise see "Bearer x" alone).
 */
const REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization header: redact everything after the label on that line, whatever scheme it uses.
  [/Authorization\s*[:=]\s*[^\r\n]+/gi, `Authorization: ${CENSOR}`],
  // A bare "Bearer <token>" that did not appear after an Authorization label.
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${CENSOR}`],
  // This app's own API key format: aip_<keyId>_<secret>.
  [/aip_[A-Za-z0-9]+_[A-Za-z0-9_-]{10,}/g, CENSOR],
  // user:password@host inside a connection string / URL (e.g. postgres://user:pass@host/db).
  [/:\/\/([^:/\s@]+):[^@\s]+@/g, `://$1:${CENSOR}@`],
  // Generic credential assignments, covering the keys listed above with either separator.
  [new RegExp(`\\b(${CREDENTIAL_ASSIGNMENT_KEYS.join("|")})\\b\\s*[:=]\\s*\\S+`, "gi"), `$1=${CENSOR}`],
];

/** Redacts known secret shapes out of free text. Never returns the matched secret value, only `[REDACTED]`. */
export function redactSecrets(text: string): string {
  return REDACTION_PATTERNS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}
