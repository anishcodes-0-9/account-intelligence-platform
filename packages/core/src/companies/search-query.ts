import { ValidationError } from "../errors/app-error.js";

export const FILLER_TERMS: ReadonlySet<string> = new Set(["company", "companies", "inc", "ltd", "pty"]);

/** Lower-cased alphanumeric word tokens; punctuation and whitespace are separators. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Turns a free-text query into the unique meaningful tokens that must all match.
 * A blank query yields no tokens (no text filter); a non-blank query with nothing
 * meaningful (only filler words or punctuation) is a validation error.
 */
export function parseSearchQuery(query: string | undefined): string[] {
  if (query === undefined || query.trim() === "") return [];
  const meaningful = [...new Set(tokenize(query).filter((t) => !FILLER_TERMS.has(t)))];
  if (meaningful.length === 0) {
    throw new ValidationError(
      `query must contain at least one meaningful search term (ignored words: ${[...FILLER_TERMS].join(", ")})`,
    );
  }
  return meaningful;
}

/** Whole-token match: every query token must equal a token of at least one searchable field. */
export function matchesAllTokens(fields: readonly string[], queryTokens: readonly string[]): boolean {
  const haystack = new Set(fields.flatMap(tokenize));
  return queryTokens.every((t) => haystack.has(t));
}
