import { z } from "zod";

/** Topics look like `actions`, `action:<id>` or `service-logs:<project>/<service>`. */
export const realtimeTopic = z
  .string()
  .regex(/^[a-z][a-z-]{0,31}(:[A-Za-z0-9_./-]{1,200})?$/, "Invalid topic");

/** Frames the browser sends on /api/v1/ws. */
export const realtimeClientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), topic: realtimeTopic }),
  z.object({ t: z.literal("unsub"), topic: realtimeTopic }),
]);
export type RealtimeClientFrame = z.infer<typeof realtimeClientFrame>;

/** Frames the server sends on /api/v1/ws. */
export const realtimeServerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("data"), topic: z.string(), payload: z.unknown() }),
  z.object({ t: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type RealtimeServerFrame = z.infer<typeof realtimeServerFrame>;
