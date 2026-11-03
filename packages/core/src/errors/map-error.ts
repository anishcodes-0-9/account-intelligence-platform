import type { ErrorCode, ErrorResponse } from "@aip/contracts";
import { AppError } from "./app-error.js";

export const INTERNAL_ERROR_MESSAGE = "An internal error occurred.";

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  PROVIDER_ERROR: 502,
  EXPORT_LIMIT: 422,
  INTERNAL: 500,
};

/** Structurally satisfied by pino's Logger. */
export interface ErrorLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface MappedError {
  httpStatus: number;
  body: ErrorResponse;
}

/**
 * The single place errors become client responses, for REST and MCP adapters alike.
 * AppErrors keep their message; anything else (SQL errors, SDK errors, bugs) and INTERNAL
 * AppErrors are logged in full and replaced by a generic message.
 */
export function mapError(error: unknown, logger: ErrorLogger, context: Record<string, unknown> = {}): MappedError {
  if (error instanceof AppError && error.code !== "INTERNAL") {
    if (error.cause !== undefined) logger.error({ ...context, err: error, code: error.code }, "request failed");
    return { httpStatus: HTTP_STATUS[error.code], body: { error: { code: error.code, message: error.message } } };
  }
  logger.error({ ...context, err: error }, "unexpected error");
  return {
    httpStatus: HTTP_STATUS.INTERNAL,
    body: { error: { code: "INTERNAL", message: INTERNAL_ERROR_MESSAGE } },
  };
}
