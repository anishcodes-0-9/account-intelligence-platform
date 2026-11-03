import type { ErrorCode } from "@aip/contracts";
import type { ZodError } from "zod/v4";

/** Expected, client-presentable failures. The message is safe to show to callers. */
export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super("VALIDATION_ERROR", message);
  }

  /** Field paths and rule messages only; zod v4 messages do not echo the offending input. */
  static fromZod(error: ZodError): ValidationError {
    const issues = error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
    return new ValidationError(issues.join("; "));
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super("NOT_FOUND", message);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHENTICATED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Insufficient permissions") {
    super("FORBIDDEN", message);
  }
}

/** `cause` (the raw provider failure) is logged internally and never sent to clients. */
export class ProviderError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("PROVIDER_ERROR", message, options);
  }
}

export class ExportLimitError extends AppError {
  constructor(message: string) {
    super("EXPORT_LIMIT", message);
  }
}

/** For deliberate internal failures. The message is logged but never shown to clients. */
export class InternalError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("INTERNAL", message, options);
  }
}
