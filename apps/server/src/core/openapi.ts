import { z } from "@hono/zod-openapi";
import { apiError } from "@opsifier/contract";

type SchemaDefinition = Record<string, unknown> & { type: string };

/** One child schema, rebuilt if it is there. */
const closedChild = (definition: SchemaDefinition, key: string) =>
  definition[key] === undefined ? {} : { [key]: closed(definition[key] as z.ZodType) };

/**
 * The same schema with every object in it refusing keys it does not know, so a field someone
 * misspells or adds is an answer and not silently ignored. An object that says it is open stays open.
 * Only an intersection is left as it is, since each of its sides would refuse the other's keys.
 */
function closed<T extends z.ZodType>(schema: T): T {
  const definition = schema._zod.def as unknown as SchemaDefinition;
  const rebuilt = (changes: object) => schema.clone({ ...definition, ...changes } as never) as T;
  switch (definition.type) {
    case "object":
      return rebuilt({
        shape: Object.fromEntries(
          Object.entries(definition.shape as Record<string, z.ZodType>).map(([key, value]) => [
            key,
            closed(value),
          ]),
        ),
        catchall: definition.catchall ?? z.never(),
      });
    case "array":
      return rebuilt(closedChild(definition, "element"));
    case "union":
      return rebuilt({ options: (definition.options as z.ZodType[]).map(closed) });
    case "tuple":
      return rebuilt({
        items: (definition.items as z.ZodType[]).map(closed),
        ...closedChild(definition, "rest"),
      });
    case "record":
      return rebuilt(closedChild(definition, "valueType"));
    case "pipe":
      return rebuilt({ ...closedChild(definition, "in"), ...closedChild(definition, "out") });
    case "lazy":
      return rebuilt({ getter: () => closed((definition.getter as () => z.ZodType)()) });
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      return rebuilt(closedChild(definition, "innerType"));
    default:
      return schema;
  }
}

/** A JSON request body. `required` matters: without it a route skips validation entirely. */
export function jsonBody<T extends z.ZodType>(schema: T) {
  return { required: true, content: { "application/json": { schema: closed(schema) } } } as const;
}

/** For a route that also works with nothing sent. What is sent is held to the same rules. */
export function optionalJsonBody<T extends z.ZodType>(schema: T) {
  return { required: false, content: { "application/json": { schema: closed(schema) } } } as const;
}

export function jsonResponse<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { "application/json": { schema } } } as const;
}

export function errorResponse(description: string) {
  return jsonResponse(apiError, description);
}
