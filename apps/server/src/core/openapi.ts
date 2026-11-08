import type { z } from "@hono/zod-openapi";
import { apiError } from "@opsifier/contract";

/** A JSON request body. `required` matters: without it a route skips validation entirely. */
export function jsonBody<T extends z.ZodType>(schema: T) {
  return { required: true, content: { "application/json": { schema } } } as const;
}

export function jsonResponse<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { "application/json": { schema } } } as const;
}

export function errorResponse(description: string) {
  return jsonResponse(apiError, description);
}
