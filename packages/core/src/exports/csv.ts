/** Public column names (the contracts' contact fields). Internal columns such as companyId or timestamps are never exported. */
export const CSV_COLUMNS = ["id", "name", "title", "email", "linkedin"] as const;
export type CsvRow = Record<(typeof CSV_COLUMNS)[number], string | null>;

const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Spreadsheets evaluate cells that start with these characters, so they are prefixed with a single quote
 * (OWASP CSV-injection guidance), which turns the cell into plain text.
 */
export function neutralizeFormula(value: string): string {
  return FORMULA_PREFIXES.some((p) => value.startsWith(p)) ? `'${value}` : value;
}

/** RFC 4180 quoting: wrap fields containing a comma, quote, CR or LF, doubling embedded quotes. */
export function escapeCsvField(value: string | null): string {
  if (value === null) return "";
  const safe = neutralizeFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CRLF line endings as RFC 4180 specifies. */
export function buildContactsCsv(rows: readonly CsvRow[]): string {
  const lines = [CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((c) => escapeCsvField(row[c])).join(","))];
  return lines.join("\r\n") + "\r\n";
}
