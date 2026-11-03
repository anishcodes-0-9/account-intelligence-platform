import { describe, expect, it } from "vitest";
import { createLogger, describeError, mapError, NotFoundError, ProviderError, sanitizeProviderError } from "../src/index.js";
import { captureLogs } from "./support/helpers.js";

const FAKE_SECRETS = ["S3kretPass!", "abc.def.ghi", "superSecretValue", "verySecretAccessToken", "verySecretRefreshToken", "anotherFakeSecret"];

/** The exact shape EnrichmentService throws: a ProviderError wrapping the real, unsanitized provider failure. */
function rawProviderFailure(): Error {
  return new Error(
    [
      "password=S3kretPass!",
      "Authorization: Bearer abc.def.ghi",
      "aip_test123_superSecretValue",
      "access_token=verySecretAccessToken",
      "refresh_token=verySecretRefreshToken",
      "secret: anotherFakeSecret",
    ].join(" | "),
  );
}

/** True if `value`, or anything reachable from it, is still a live Error instance. */
function containsLiveError(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof Error) return true;
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((v) => containsLiveError(v, seen));
}

describe("describeError never lets a live Error (or its cause) through", () => {
  it("returns a plain object, not an Error, for a top-level error and its cause chain", () => {
    const cause = rawProviderFailure();
    const error = new ProviderError("Enrichment provider failed", { cause });
    const described = describeError(error);

    expect(described).not.toBeInstanceOf(Error);
    expect(containsLiveError(described)).toBe(false);
    for (const secret of FAKE_SECRETS) expect(JSON.stringify(described)).not.toContain(secret);
  });

  it("terminates on a circular cause chain instead of recursing forever", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a; // circular

    const described = describeError(a);
    expect(containsLiveError(described)).toBe(false);
    // Reaching this line at all (without a stack overflow) is most of the proof; also check it's finite
    // and terminates well short of what an actual infinite cycle would produce.
    let depth = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = described;
    while (node?.cause && typeof node.cause === "object") {
      depth++;
      node = node.cause;
    }
    expect(depth).toBeLessThanOrEqual(6);
  });

  it("bounds an unbounded (non-circular) cause chain to a fixed depth", () => {
    let top: Error & { cause?: unknown } = new Error("root cause");
    for (let i = 0; i < 20; i++) {
      const next: Error & { cause?: unknown } = new Error(`level ${i}`);
      next.cause = top;
      top = next;
    }
    const described = describeError(top);
    expect(containsLiveError(described)).toBe(false);
    let depth = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = described;
    while (node?.cause && typeof node.cause === "object") {
      depth++;
      node = node.cause;
    }
    expect(depth).toBeLessThanOrEqual(6); // MAX_CAUSE_DEPTH (5) plus the truncation marker itself
  });

  it("sanitizes a nested Error found in structured log context, not just the top-level `err` field", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    logger.info({ contactId: "cnt_1", detail: { nestedError: rawProviderFailure() } }, "note");

    const text = logs.text();
    for (const secret of FAKE_SECRETS) expect(text).not.toContain(secret);
    const [line] = logs.lines();
    expect(containsLiveError(line)).toBe(false);
  });
});

class FakeDbConfig {
  constructor(
    public password: string,
    public host: string,
  ) {}
}

describe("non-Error values are normalized before they ever reach Pino", () => {
  it("reduces a custom class instance to its type name only, never its fields", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    logger.info({ config: new FakeDbConfig("S3kretClassPass!", "db.example.com") }, "config loaded");

    const text = logs.text();
    expect(text).not.toContain("S3kretClassPass!");
    expect(text).not.toContain("db.example.com"); // no field of the instance is serialized, not just the secret one
    const [line] = logs.lines();
    expect(line!.config).toEqual({ type: "FakeDbConfig" });
  });

  it("normalizes a Map's entries (and still redacts a credential assignment inside one)", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    const lookup = new Map<string, string>([["note", "ok"], ["detail", "api_key=FakeMapToken123"]]);
    logger.info({ lookup }, "lookup ran");

    const text = logs.text();
    expect(text).not.toContain("FakeMapToken123");
    const [line] = logs.lines();
    expect(line!.lookup).toMatchObject({ type: "Map", size: 2 });
    expect(JSON.stringify(line!.lookup)).toContain("[REDACTED]");
  });

  it("normalizes a Set's values the same way", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    logger.info({ tags: new Set(["a", "secret=FakeSetSecret456", "b"]) }, "tagged");

    const text = logs.text();
    expect(text).not.toContain("FakeSetSecret456");
    const [line] = logs.lines();
    expect(line!.tags).toMatchObject({ type: "Set", size: 3 });
  });

  it("reduces a Buffer/typed array to its type and length, never its raw bytes", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    logger.info({ payload: Buffer.from("not-logged-content") }, "received");

    const text = logs.text();
    expect(text).not.toContain("not-logged-content");
    const [line] = logs.lines();
    expect(line!.payload).toMatchObject({ type: "Buffer", byteLength: Buffer.byteLength("not-logged-content") });
  });

  it("serializes a Date as an ISO string", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    logger.info({ occurredAt: new Date("2026-01-01T00:00:00.000Z") }, "event");

    const [line] = logs.lines();
    expect(line!.occurredAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("terminates on a circular plain object instead of recursing forever, and still redacts a sibling field", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    const obj: Record<string, unknown> = { note: "ok", password: "circSecretPass" };
    obj.self = obj; // circular

    logger.info(obj, "circular");

    const text = logs.text();
    // Redacted by key name at every depth the cycle is unrolled to, not just Pino's own 2-level wildcarding.
    expect(text).not.toContain("circSecretPass");
    expect(() => JSON.parse(text.trim())).not.toThrow(); // finite output: the cycle did not hang or crash the process
  });

  it("leaves an ordinary plain object with safe diagnostic fields untouched", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    logger.info({ query: "AI companies", limit: 10, filters: { country: "Australia" } }, "search ran");

    const [line] = logs.lines();
    expect(line).toMatchObject({ query: "AI companies", limit: 10, filters: { country: "Australia" } });
  });
});

describe("mapError's logging path never exposes provider secrets", () => {
  it("keeps every fake secret out of the captured Pino JSON output, including the nested cause", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    mapError(new ProviderError("Enrichment provider failed", { cause: rawProviderFailure() }), logger, { contactId: "cnt_1" });

    const text = logs.text();
    for (const secret of FAKE_SECRETS) expect(text).not.toContain(secret);
    const [line] = logs.lines();
    expect(containsLiveError(line)).toBe(false);
  });

  it("keeps a sanitized message and stack available for the top-level error and its cause", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    mapError(new ProviderError("Enrichment provider failed", { cause: rawProviderFailure() }), logger);

    const [line] = logs.lines();
    const err = line!.err as { message: string; stack: string; cause: { message: string; stack: string } };
    expect(err.message).toBe("Enrichment provider failed");
    expect(err.stack).toContain("log-redaction.test.ts");
    expect(err.cause.message).not.toContain("S3kretPass!");
    expect(err.cause.stack).toContain("log-redaction.test.ts");
    for (const secret of FAKE_SECRETS) {
      expect(err.message).not.toContain(secret);
      expect(err.stack).not.toContain(secret);
      expect(err.cause.message).not.toContain(secret);
      expect(err.cause.stack).not.toContain(secret);
    }
  });

  it("still carries safe diagnostic context: the app error code and caller-supplied context", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    mapError(new ProviderError("Enrichment provider failed", { cause: rawProviderFailure() }), logger, { contactId: "cnt_1", provider: "mock-synthetic" });

    const [line] = logs.lines();
    expect(line).toMatchObject({ contactId: "cnt_1", provider: "mock-synthetic", code: "PROVIDER_ERROR" });
    expect((line!.err as Record<string, unknown>).type).toBe("ProviderError");
  });

  it("keeps provider error persistence sanitized by the same shared redaction logic used in logging", () => {
    const stored = sanitizeProviderError(rawProviderFailure());
    for (const secret of FAKE_SECRETS) expect(stored).not.toContain(secret);
  });

  it("does not mangle an ordinary, non-sensitive diagnostic message", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    mapError(new ProviderError("Enrichment provider failed", { cause: new Error("upstream timed out after 5000ms calling https://vendor.example/lookup") }), logger);

    const text = logs.text();
    expect(text).toContain("upstream timed out after 5000ms");
    expect(text).toContain("vendor.example/lookup");
  });

  it("still maps and logs an ordinary AppError (no cause) with its real message intact -- existing classification unchanged", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    const mapped = mapError(new NotFoundError("Contact not found: cnt_99"), logger);
    expect(mapped.body.error).toEqual({ code: "NOT_FOUND", message: "Contact not found: cnt_99" });
    // NotFoundError has no cause, so mapError does not log it at all -- nothing to assert about logs.text() here.
    expect(logs.text()).toBe("");
  });

  it("maps an unexpected non-AppError to a generic INTERNAL client response while still logging safe detail server-side", () => {
    const logs = captureLogs();
    const logger = createLogger({ destination: logs.destination });
    const mapped = mapError(new Error("db failure: password=super-secret-value"), logger);
    expect(mapped.body.error).toEqual({ code: "INTERNAL", message: "An internal error occurred." });
    expect(JSON.stringify(mapped.body)).not.toContain("super-secret-value");
    // Full server-side diagnostics stay available (M3 design), just with the credential redacted.
    expect(logs.text()).toContain("db failure");
    expect(logs.text()).not.toContain("super-secret-value");
  });
});
