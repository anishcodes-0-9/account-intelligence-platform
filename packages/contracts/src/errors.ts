import * as z from "zod/v4";

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "PROVIDER_ERROR",
  "EXPORT_LIMIT",
  "INTERNAL",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** The one error shape every transport returns (REST body, MCP `structuredContent`). */
export const ErrorResponseSchema = z.object({
  error: z.object({ code: ErrorCodeSchema, message: z.string() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
