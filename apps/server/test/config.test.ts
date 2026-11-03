import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = { DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/aip" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(valid)).toMatchObject({ HOST: "127.0.0.1", PORT: 3001, LOG_LEVEL: "info", NODE_ENV: "development" });
  });

  it("fails fast with a readable message that does not echo secret values", () => {
    const secretish = "not-a-url-with-password-hunter2";
    expect(() => loadConfig({ DATABASE_URL: secretish })).toThrow(/Invalid environment: DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: secretish })).not.toThrow(/hunter2/);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...valid, PORT: "99999" })).toThrow(/PORT/);
  });
});
