import { ErrorResponseSchema, ERROR_CODES, type ErrorCode } from "@aip/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AppError } from "../src/index.js";
import {
  ExportLimitError, ForbiddenError, INTERNAL_ERROR_MESSAGE, InternalError, NotFoundError, ProviderError,
  UnauthenticatedError, ValidationError, createLogger, mapError,
} from "../src/index.js";
import { parseInput } from "../src/errors/parse-input.js";
import { SearchCompaniesInputSchema } from "@aip/contracts";
import { captureLogs } from "./support/helpers.js";
import { createIsolatedDb, type IsolatedDb } from "./support/test-db.js";

const setup = () => {
  const logs = captureLogs();
  return { logs, logger: createLogger({ destination: logs.destination }) };
};

describe("mapError: expected errors", () => {
  const cases: Array<[AppError, ErrorCode, number]> = [
    [new ValidationError("limit: too big"), "VALIDATION_ERROR", 400],
    [new NotFoundError("Company not found: cmp_9"), "NOT_FOUND", 404],
    [new UnauthenticatedError(), "UNAUTHENTICATED", 401],
    [new ForbiddenError("Missing required scope: contacts:read"), "FORBIDDEN", 403],
    [new ProviderError("Enrichment provider unavailable"), "PROVIDER_ERROR", 502],
    [new ExportLimitError("At most 200 contacts per export"), "EXPORT_LIMIT", 422],
  ];

  it.each(cases)("%s keeps its code and useful message", (error, code, status) => {
    const { logger, logs } = setup();
    const mapped = mapError(error, logger);
    expect(mapped.httpStatus).toBe(status);
    expect(mapped.body).toEqual({ error: { code, message: error.message } });
    expect(ErrorResponseSchema.parse(mapped.body)).toEqual(mapped.body);
    expect(logs.text()).toBe(""); // expected errors are not log noise
  });

  it("covers every contract error code", () => {
    const codes = new Set<string>([...cases.map(([, c]) => c), "INTERNAL"]);
    expect([...codes].sort()).toEqual([...ERROR_CODES].sort());
  });

  it("logs a provider failure's cause internally but never sends it to the client", () => {
    const { logger, logs } = setup();
    const cause = new Error("connect ECONNREFUSED 10.0.0.5:443 api_key=hunter2");
    const mapped = mapError(new ProviderError("Enrichment provider unavailable", { cause }), logger, { contactId: "cnt_1" });
    expect(mapped.body.error.message).toBe("Enrichment provider unavailable");
    expect(JSON.stringify(mapped.body)).not.toContain("ECONNREFUSED");
    expect(logs.text()).toContain("ECONNREFUSED");
    expect(logs.lines()[0]).toMatchObject({ level: 50, contactId: "cnt_1", code: "PROVIDER_ERROR" });
  });
});

describe("mapError: unexpected errors", () => {
  it("replaces a raw error with a generic INTERNAL response and logs full details", () => {
    const { logger, logs } = setup();
    const error = new Error("SELECT * FROM users WHERE password='hunter2' failed at /srv/app/db.ts:42");
    const mapped = mapError(error, logger, { requestId: "req-1", tool: "search_companies" });
    expect(mapped).toEqual({ httpStatus: 500, body: { error: { code: "INTERNAL", message: INTERNAL_ERROR_MESSAGE } } });
    const body = JSON.stringify(mapped.body);
    for (const leak of ["SELECT", "hunter2", "/srv/app", "stack", "Error:"]) expect(body).not.toContain(leak);

    const line = logs.lines()[0] as { msg: string; requestId: string; tool: string; err: { message: string; stack: string } };
    expect(line).toMatchObject({ msg: "unexpected error", requestId: "req-1", tool: "search_companies" });
    expect(line.err.message).toContain("SELECT * FROM users"); // full detail stays server-side
    expect(line.err.stack).toContain("errors.test.ts");
  });

  it("sanitises the SDK-style thrown error the M1 spike showed would otherwise reach clients", () => {
    const { logger } = setup();
    const mapped = mapError(new Error("boom: secret-internal-detail"), logger);
    expect(JSON.stringify(mapped.body)).not.toContain("secret-internal-detail");
  });

  it("treats a deliberate InternalError as unexpected: message logged, never returned", () => {
    const { logger, logs } = setup();
    const mapped = mapError(new InternalError("invariant broken: export row missing"), logger);
    expect(mapped.body).toEqual({ error: { code: "INTERNAL", message: INTERNAL_ERROR_MESSAGE } });
    expect(logs.text()).toContain("invariant broken");
  });

  it("handles thrown non-Error values, and scrubs raw keys from what it logs", () => {
    const { logger, logs } = setup();
    const rawKey = `aip_cabc123_${"Z".repeat(43)}`;
    for (const thrown of ["plain string", `failed with ${rawKey}`, null, undefined, 42, { detail: "x" }]) {
      const mapped = mapError(thrown, logger);
      expect(mapped.body.error).toEqual({ code: "INTERNAL", message: INTERNAL_ERROR_MESSAGE });
    }
    expect(logs.text()).not.toContain("Z".repeat(43));
  });
});

describe("mapError: a real database failure", () => {
  let db: IsolatedDb;
  beforeAll(async () => {
    db = await createIsolatedDb(inject("templateDb"));
  });
  afterAll(() => db.drop());

  it("never exposes SQL or schema details to the client but logs them", async () => {
    const { logger, logs } = setup();
    let error: unknown;
    try {
      await db.prisma.$queryRawUnsafe("SELECT * FROM table_that_does_not_exist");
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    const mapped = mapError(error, logger);
    expect(mapped.body.error).toEqual({ code: "INTERNAL", message: INTERNAL_ERROR_MESSAGE });
    expect(JSON.stringify(mapped.body)).not.toMatch(/table_that_does_not_exist|SELECT|relation|prisma/i);
    expect(logs.text()).toContain("table_that_does_not_exist");
  });
});

describe("ValidationError.fromZod / parseInput", () => {
  it("reports field paths and rules, never the offending value", () => {
    let error: unknown;
    try {
      parseInput(SearchCompaniesInputSchema, { query: "ok", limit: "SECRET-VALUE-123", country: ["x"] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    const message = (error as ValidationError).message;
    expect(message).toContain("limit:");
    expect(message).toContain("country:");
    expect(message).not.toContain("SECRET-VALUE-123");
  });
});
