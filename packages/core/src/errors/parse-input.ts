import type { ZodType } from "zod/v4";
import { ValidationError } from "./app-error.js";

/** Validates untrusted input with a contracts schema; every service entry point goes through this. */
export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw ValidationError.fromZod(result.error);
  return result.data;
}

/** Blank strings mean "not provided" for optional filters. */
export function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
