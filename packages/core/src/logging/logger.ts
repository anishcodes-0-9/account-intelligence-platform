import pino, { type DestinationStream, type LogFn, type Logger } from "pino";

export type { Logger };

const CENSOR = "[REDACTED]";

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

/** Catches secrets that end up inside free text (messages, string fields) where path redaction cannot see them. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/aip_[a-z0-9]+_[A-Za-z0-9_-]{20,}/g, CENSOR],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${CENSOR}`],
];

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return SECRET_PATTERNS.reduce((s, [re, to]) => s.replace(re, to), value);
  if (depth >= 5 || value === null || typeof value !== "object" || value instanceof Error) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, depth + 1)]));
}

/** pino's error serializer returns a non-plain object, so scrub its fields (type, message, stack, ...) directly. */
function scrubbedError(error: unknown): unknown {
  if (!(error instanceof Error)) return scrub(error); // thrown strings, null, plain objects
  return Object.fromEntries(Object.entries(pino.stdSerializers.err(error)).map(([k, v]) => [k, scrub(v)]));
}

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
    // Error messages and stacks bypass the hook below, so scrub the serialized error too.
    serializers: { err: scrubbedError },
    hooks: {
      logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn) {
        method.apply(this, args.map((a) => scrub(a)) as Parameters<LogFn>);
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
