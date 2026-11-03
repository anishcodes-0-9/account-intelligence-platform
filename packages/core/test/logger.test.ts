import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/index.js";
import { captureLogs } from "./support/helpers.js";

const RAW_KEY = `aip_cmwabc123_${"k".repeat(43)}`;
const BEARER = "Bearer eyJhbGciOi.payload.sig";

function log(write: (logger: ReturnType<typeof createLogger>) => void, level = "info"): { text: string; line: Record<string, unknown> } {
  const logs = captureLogs();
  write(createLogger({ destination: logs.destination, level }));
  return { text: logs.text(), line: logs.lines()[0] ?? {} };
}

describe("structured logging", () => {
  it("emits one JSON object per line with level, ISO time, service and message", () => {
    const { text, line } = log((l) => l.info({ contactId: "cnt_1", tool: "enrich_contact" }, "tool call"));
    expect(text.endsWith("\n")).toBe(true);
    expect(line).toMatchObject({ level: 30, service: "aip", msg: "tool call", contactId: "cnt_1", tool: "enrich_contact" });
    expect(String(line.time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("respects the level", () => {
    expect(log((l) => l.debug("hidden")).text).toBe("");
    expect(log((l) => l.debug("shown"), "debug").text).toContain("shown");
  });

  it("serialises errors with message and stack", () => {
    const { line } = log((l) => l.error({ err: new Error("kaboom") }, "failed"));
    expect(line.err).toMatchObject({ type: "Error", message: "kaboom" });
    expect(String((line.err as { stack: string }).stack)).toContain("logger.test.ts");
  });
});

describe("redaction", () => {
  it("redacts authorization headers, cookies, api keys, tokens, secrets and hashes at common paths", () => {
    const secrets = ["AUTH-HEADER-VALUE", "COOKIE-VALUE", "APIKEY-VALUE", "TOKEN-VALUE", "SECRET-VALUE", "HASH-VALUE", "PASSWORD-VALUE", "DL-TOKEN-VALUE"];
    const { text, line } = log((l) =>
      l.info(
        {
          req: { headers: { authorization: secrets[0], cookie: secrets[1] } },
          headers: { authorization: secrets[0] },
          authorization: secrets[0],
          apiKey: secrets[2],
          request: { apiKey: secrets[2] },
          token: secrets[3],
          auth: { token: secrets[3], secret: secrets[4] },
          keyHash: secrets[5],
          record: { keyHash: secrets[5], tokenHash: secrets[5] },
          password: secrets[6],
          downloadToken: secrets[7],
          deep: { a: { token: secrets[3] } },
        },
        "request",
      ),
    );
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
    expect(line.apiKey).toBe("[REDACTED]");
    expect((line.req as { headers: { authorization: string } }).headers.authorization).toBe("[REDACTED]");
    expect((line.auth as { token: string }).token).toBe("[REDACTED]");
  });

  it("redacts export download URLs (they embed the token) and contact personal data", () => {
    const { text } = log((l) =>
      l.info(
        {
          downloadUrl: "https://host/downloads/DOWNLOAD-TOKEN-XYZ",
          export: { downloadUrl: "https://host/downloads/DOWNLOAD-TOKEN-XYZ" },
          email: "jane@example.com",
          contact: { email: "jane@example.com", linkedin: "https://example.com/in/jane", fullName: "Jane Citizen", firstName: "Jane", lastName: "Citizen" },
        },
        "export ready",
      ),
    );
    for (const pii of ["DOWNLOAD-TOKEN-XYZ", "jane@example.com", "example.com/in/jane", "Jane", "Citizen"]) expect(text, pii).not.toContain(pii);
  });

  it("keeps contact identifiers rather than personal data", () => {
    const { line } = log((l) => l.info({ contactId: "cnt_42", contactIds: ["cnt_1", "cnt_2"], companyId: "cmp_7", keyId: "cmwabc123" }, "export requested"));
    expect(line).toMatchObject({ contactId: "cnt_42", contactIds: ["cnt_1", "cnt_2"], companyId: "cmp_7", keyId: "cmwabc123" });
  });

  it("scrubs raw API keys and bearer tokens that appear inside free text, anywhere in the payload", () => {
    const { text } = log((l) =>
      l.warn(
        {
          note: `caller sent ${RAW_KEY}`,
          nested: { list: [`x ${RAW_KEY}`, { header: `Authorization: ${BEARER}` }] },
          err: new Error("plain error object is left to pino's serializer"),
        },
        `rejected ${RAW_KEY} with ${BEARER}`,
      ),
    );
    expect(text).not.toContain("k".repeat(43));
    expect(text).not.toContain("eyJhbGciOi.payload.sig");
    expect(text).toContain("[REDACTED]");
  });

  it("scrubs raw keys out of error messages and stacks too", () => {
    const error = new Error(`upstream rejected ${RAW_KEY} (${BEARER})`);
    const { text, line } = log((l) => l.error({ err: error }, "call failed"));
    expect(text).not.toContain("k".repeat(43));
    expect(text).not.toContain("eyJhbGciOi.payload.sig");
    expect((line.err as { message: string }).message).toContain("[REDACTED]");
    expect(String((line.err as { stack: string }).stack)).toContain("logger.test.ts"); // stack still useful
  });

  it("does not alter harmless text", () => {
    const { line } = log((l) => l.info({ query: "AI companies", country: "Australia" }, "search ran"));
    expect(line).toMatchObject({ query: "AI companies", country: "Australia", msg: "search ran" });
  });
});

describe("stderr destination (stdio MCP keeps stdout protocol-only)", () => {
  it("writes logs to stderr, nothing to stdout, and still redacts", () => {
    const script = fileURLToPath(new URL("./support/log-to-stderr.ts", import.meta.url));
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { cwd, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const line = JSON.parse(result.stderr.trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ service: "stderr-fixture", msg: "hello from stderr", contactId: "cnt_1", apiKey: "[REDACTED]" });
    expect(result.stderr).not.toContain("SHOULD_NOT_APPEAR");
  });
});
