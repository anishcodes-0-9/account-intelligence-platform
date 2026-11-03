import { Writable } from "node:stream";
import type { Scope } from "@aip/contracts";
import type { AuthPrincipal } from "../../src/auth/principal.js";

export const principal = (...scopes: Scope[]): AuthPrincipal => ({ keyId: "test-key", name: "test", scopes });

export const ALL_READ = principal("companies:read", "contacts:read", "contacts:enrich", "contacts:export");

/** In-memory pino destination so tests can inspect exactly what would be written. */
export function captureLogs(): { destination: Writable; text: () => string; lines: () => Record<string, unknown>[] } {
  let buffer = "";
  const destination = new Writable({
    write(chunk, _enc, cb) {
      buffer += String(chunk);
      cb();
    },
  });
  return {
    destination,
    text: () => buffer,
    lines: () => buffer.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** Resolves to the thrown value so tests can assert on class, code and message together. */
export async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}
