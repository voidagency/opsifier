import type { DatabaseEngine } from "@opsifier/contract";
import { engineRuntime } from "./engines";

const NANOS_PER_SECOND = 1_000_000_000;

/**
 * A rollout only counts a task as running once its engine answers, so a deploy never reports success
 * for a database still initializing. Checks are frequent while starting and relaxed afterwards. A
 * five-minute start period gives a large first boot room, and a long failure budget keeps a busy
 * server from being replaced for one slow answer.
 */
export function compileDatabaseHealth(
  engine: DatabaseEngine,
  input: { user: string; databaseName: string | null },
): Record<string, unknown> {
  return {
    Test: engineRuntime[engine].health(input),
    Interval: 30 * NANOS_PER_SECOND,
    Timeout: 10 * NANOS_PER_SECOND,
    Retries: 10,
    StartPeriod: 300 * NANOS_PER_SECOND,
    StartInterval: 2 * NANOS_PER_SECOND,
  };
}
