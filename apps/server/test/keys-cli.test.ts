import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApiKeyRepository, ApiKeyService, UnauthenticatedError } from "@aip/core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
// Shared test-database helpers live with core's tests.
import { createIsolatedDb, type IsolatedDb } from "../../../packages/core/test/support/test-db.js";

const script = fileURLToPath(new URL("../src/bin/keys.ts", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));

let db: IsolatedDb;
beforeAll(async () => {
  db = await createIsolatedDb(inject("templateDb"));
});
afterAll(() => db.drop());

function keys(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: db.url },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("keys CLI (real process, real database)", () => {
  it("creates, lists and revokes a key; the raw key appears exactly once", async () => {
    const created = keys("create", "--name", "cli-test", "--scopes", "companies:read,contacts:read", "--expires-in-days", "30");
    expect(created.status).toBe(0);
    const key = /Key \(shown only once, store it now\): (aip_[a-z0-9]+_[A-Za-z0-9_-]{43})/.exec(created.stdout)?.[1];
    const id = /Created API key ([a-z0-9]+) \(cli-test\)/.exec(created.stdout)?.[1];
    expect(key).toBeDefined();
    expect(id).toBeDefined();
    expect(created.stdout).toContain("Scopes:  companies:read, contacts:read");
    expect(created.stderr).not.toContain(key as string);

    const service = new ApiKeyService(new ApiKeyRepository(db.prisma));
    expect(await service.verify(key)).toMatchObject({ keyId: id, name: "cli-test", scopes: ["companies:read", "contacts:read"] });
    expect((await db.prisma.apiKey.findUniqueOrThrow({ where: { id: id as string } })).expiresAt).not.toBeNull();

    const listed = keys("list");
    expect(listed.status).toBe(0);
    expect(listed.stdout).not.toContain((key as string).split("_").slice(2).join("_")); // secret never listed (it may itself contain "_")
    expect(listed.stdout).not.toContain("keyHash");
    const parsed = JSON.parse(listed.stdout) as Array<{ id: string; name: string; revokedAt: string | null }>;
    expect(parsed.find((k) => k.id === id)).toMatchObject({ name: "cli-test", revokedAt: null });

    const revoked = keys("revoke", id as string);
    expect(revoked.status).toBe(0);
    expect(revoked.stdout).toContain(`Revoked API key ${id}`);
    await expect(service.verify(key)).rejects.toBeInstanceOf(UnauthenticatedError);
    const after = JSON.parse(keys("list").stdout) as Array<{ id: string; revokedAt: string | null }>;
    expect(after.find((k) => k.id === id)?.revokedAt).not.toBeNull();
  });

  it("fails with exit code 1 and a safe message for bad usage, bad input and unknown ids", () => {
    const cases: Array<[string[], RegExp]> = [
      [[], /Usage:/],
      [["bogus"], /Usage:/],
      [["create", "--name", "x"], /VALIDATION_ERROR/],
      [["create", "--name", "x", "--scopes", "admin:all"], /VALIDATION_ERROR/],
      [["create", "--name", "x", "--scopes", "companies:read", "--expires-in-days", "-3"], /ambiguous|positive number/],
      [["create", "--name", "x", "--scopes", "companies:read", "--expires-in-days=-3"], /positive number/],
      [["create", "--name", "x", "--scopes", "companies:read", "--expires-in-days=abc"], /positive number/],
      [["create", "--bogus-flag"], /Unknown option/],
      [["revoke"], /Usage:/],
      [["revoke", "no-such-key"], /NOT_FOUND/],
    ];
    for (const [args, expected] of cases) {
      const r = keys(...args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toMatch(expected);
      expect(r.stderr).not.toMatch(/at .*\.ts:\d+/); // no stack traces
    }
  });
});
