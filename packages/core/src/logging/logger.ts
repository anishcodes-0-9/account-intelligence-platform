import pino, { type DestinationStream, type LogFn, type Logger } from "pino";
import { CENSOR, redactSecrets } from "../security/redact.js";

export type { Logger };

/** Pino redaction only reaches one wildcard level, so common nestings are listed explicitly. */
const SENSITIVE_KEYS = [
  "authorization", "cookie", "apiKey", "rawKey", "key", "token", "secret", "password",
  "keyHash", "tokenHash", "downloadToken", "downloadUrl",
  "email", "linkedin", "firstName", "lastName", "fullName",
];
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.flatMap((k) => [`*.${k}`, `*.*.${k}`]),
];

/** `scrub()`'s own key-based check below reaches any depth; this exists for Pino's structural `redact.paths` option. */
const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

/** A download URL embeds its token; nothing else here is specific to this logger (see `security/redact.ts`). */
const DOWNLOAD_URL_PATTERN: [RegExp, string] = [/(\/downloads\/)[A-Za-z0-9_-]{20,}/g, `$1${CENSOR}`];

function scrubString(value: string): string {
  const [pattern, replacement] = DOWNLOAD_URL_PATTERN;
  return redactSecrets(value.replace(pattern, replacement));
}

/** A safe stand-in for an object type this logger does not know how to normalize further: its name only. */
function typePlaceholder(value: object): Record<string, unknown> {
  return { type: value.constructor?.name ?? "object" };
}

/**
 * Normalizes any value into one of: `null`, a redacted string, a number, a boolean, an array of
 * normalized values, or a plain object of normalized values -- the only shapes that reach Pino. A type
 * this function does not recognize (a custom class instance, or an object past the depth limit) becomes
 * a `{ type }` placeholder instead of being passed through: nothing here ever hands Pino an arbitrary
 * object to serialize on its own terms (no `toJSON`, no enumerating unknown fields), since that object
 * could hold anything, including a secret this module has no way to find and redact.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value instanceof Error) return describeError(value); // never left as a live Error, at any depth
  if (value === null || typeof value !== "object") return value; // primitives pass through unchanged
  if (depth >= 5) return typePlaceholder(value); // bound recursion without leaking the raw object
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return { type: "Map", size: value.size, entries: [...value.entries()].map(([k, v]) => [scrub(k, depth + 1), scrub(v, depth + 1)]) };
  if (value instanceof Set) return { type: "Set", size: value.size, values: [...value.values()].map((v) => scrub(v, depth + 1)) };
  if (ArrayBuffer.isView(value)) return { type: value.constructor?.name ?? "Buffer", byteLength: value.byteLength };
  if (Object.getPrototypeOf(value) === Object.prototype) {
    // Pino's own `redact.paths` wildcarding only reaches two nesting levels (see REDACT_PATHS above);
    // matching sensitive key names here too means a `password` ten levels deep is still never passed
    // through, regardless of its type -- not just when its *content* happens to match a known pattern.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY_SET.has(k.toLowerCase()) ? CENSOR : scrub(v, depth + 1)]));
  }
  return typePlaceholder(value); // an unrecognized class instance: its type name only, never its fields
}

const MAX_CAUSE_DEPTH = 5;

/**
 * The one place an Error becomes loggable: a fully plain, pre-sanitized object built without ever
 * calling Pino's standard `err` serializer on the original Error. That serializer concatenates
 * `cause.message`/`cause.stack` from the *original, unsanitized* Error chain into its own output before
 * any redaction could run -- the root cause of a since-fixed logging leak (see `progress.md`). Here,
 * every string (this error's own message/stack, and its cause chain's) is redacted before assembly, and
 * no reference to the original Error, its `cause`, or any other raw object survives in the result --
 * Pino never receives anything but plain strings and primitives.
 *
 * `seen` guards a circular `cause` chain (e.g. `a.cause = b; b.cause = a`) and `MAX_CAUSE_DEPTH` bounds
 * an unbounded (but non-circular) one; either way the result stays a finite, plain object.
 */
function describeError(error: Error, seen: Set<Error> = new Set(), depth = 0): Record<string, unknown> {
  seen.add(error);
  const fields: Record<string, unknown> = { type: error.constructor?.name ?? error.name, message: scrubString(String(error.message)) };
  if (typeof error.stack === "string") fields.stack = scrubString(error.stack);
  for (const [key, value] of Object.entries(error)) {
    if (key === "stack" || key === "cause") continue; // stack is handled above; cause is handled below
    fields[key] = SENSITIVE_KEY_SET.has(key.toLowerCase()) ? CENSOR : scrub(value, depth + 1);
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    fields.cause =
      depth < MAX_CAUSE_DEPTH && !seen.has(cause)
        ? describeError(cause, seen, depth + 1)
        : { type: cause.constructor?.name ?? cause.name, message: "[cause chain truncated]" };
  } else if (cause !== undefined) {
    fields.cause = scrub(cause, depth + 1);
  }
  return fields;
}

function scrubbedError(error: unknown): unknown {
  if (!(error instanceof Error)) return scrub(error); // thrown strings, null, plain objects
  return describeError(error);
}

/** Exported so tests can assert directly that no Error instance survives into the logged representation. */
export { describeError };

export interface LoggerOptions {
  level?: string;
  name?: string;
  /** Defaults to stdout. Use {@link stderrDestination} under stdio MCP, where stdout is protocol-only. */
  destination?: DestinationStream;
}

export function stderrDestination(): DestinationStream {
  return pino.destination({ fd: 2, sync: true });
}

/** Structured JSON logger. Log contact ids, never contact personal data. */
export function createLogger({ level = "info", name = "aip", destination }: LoggerOptions = {}): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    // Belt and suspenders: the hook below already turns any Error (anywhere in the log object, not just
    // `err`) into a safe plain object before Pino ever sees it, via the same `describeError`. This named
    // serializer covers the case where something still reaches Pino as a live Error despite that -- it
    // is never itself what calls Pino's standard `err` serializer on a raw Error.
    serializers: { err: scrubbedError },
    hooks: {
      logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn) {
        method.apply(this, args.map((a) => scrub(a)) as Parameters<LogFn>);
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
