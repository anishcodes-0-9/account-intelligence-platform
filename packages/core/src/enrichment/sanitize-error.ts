import { redactSecrets } from "../security/redact.js";

const MAX_LENGTH = 300;

/**
 * Turns a thrown provider failure into a safe, bounded string for persistence (never the stack).
 * Caller must still raise its own error for the failure itself; this never returns success.
 */
export function sanitizeProviderError(cause: unknown, maxLength = MAX_LENGTH): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return redactSecrets(raw).slice(0, maxLength);
}
