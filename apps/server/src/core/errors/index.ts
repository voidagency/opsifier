import type { ApiError } from "@opsifier/contract";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";
import type { $ZodIssue } from "zod/v4/core";

type Fields = Record<string, string>;

/** Every failure a route deliberately reports. Anything else becomes a 500 with no detail. */
export class AppError extends Error {
  override readonly name = "AppError";

  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly fields?: Fields,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, fields?: Fields) =>
  new AppError(400, code, message, fields);
export const unauthorized = (code: string, message: string, fields?: Fields) =>
  new AppError(401, code, message, fields);
export const forbidden = (code: string, message: string, fields?: Fields) =>
  new AppError(403, code, message, fields);
export const notFound = (message = "Not found.") => new AppError(404, "not_found", message);
export const conflict = (code: string, message: string, fields?: Fields) =>
  new AppError(409, code, message, fields);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new AppError(429, "rate_limited", "Too many attempts. Try again later.", undefined, {
    "Retry-After": String(retryAfterSeconds),
  });
export const serviceUnavailable = (code: string, message: string) => new AppError(503, code, message);

export function errorBody(code: string, message: string, fields?: Fields): ApiError {
  return { error: fields === undefined ? { code, message } : { code, message, fields } };
}

type Issue = Pick<$ZodIssue, "path" | "message" | "code">;

/** A missing value reads "expected string, received undefined" by default, which no form should show. */
function issueMessage(issue: Issue): string {
  return issue.code === "invalid_type" && issue.message.endsWith("received undefined")
    ? "Required"
    : issue.message;
}

/** Maps Zod issues to `{ "a.b": "message" }`, keeping the first message for each field. */
export function issuesToFields(issues: readonly Issue[]): Fields {
  const fields: Fields = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".");
    if (key !== "" && fields[key] === undefined) {
      fields[key] = issueMessage(issue);
    }
  }
  return fields;
}

export function validationResponse(c: Context, issues: readonly Issue[]): Response {
  const [first] = issues;
  const fields = issuesToFields(issues);
  // A body that is not an object at all has no field to attach the message to.
  const message =
    Object.keys(fields).length === 0 && first !== undefined ? first.message : "Some fields need attention.";
  return c.json(errorBody("validation_failed", message, fields), 400);
}

/** The `defaultHook` of every route: a failed validation is always a 400 with `fields`. */
export function validationHook(
  result: { success: true } | { success: false; error: { issues: readonly Issue[] } },
  c: Context,
): Response | undefined {
  return result.success ? undefined : validationResponse(c, result.error.issues);
}

const httpExceptionCodes: Partial<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
};

export function createErrorHandler(logger: Logger): ErrorHandler {
  return (error, c) => {
    if (error instanceof AppError) {
      for (const [name, value] of Object.entries(error.headers ?? {})) {
        c.header(name, value);
      }
      return c.json(errorBody(error.code, error.message, error.fields), error.status);
    }
    if (error instanceof HTTPException) {
      const code = httpExceptionCodes[error.status] ?? "http_error";
      return c.json(errorBody(code, error.message || "The request could not be processed."), error.status);
    }
    logger.error({ err: error, method: c.req.method, path: c.req.path }, "Unhandled error");
    return c.json(errorBody("internal_error", "Something went wrong on the server."), 500);
  };
}

export const notFoundHandler: NotFoundHandler = (c) => c.json(errorBody("not_found", "Not found."), 404);
