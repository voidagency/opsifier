import type { Config } from "../config";
import { FakeTools } from "./fake";
import { realTools, type ToolRunner } from "./runner";

export {
  FAKE_GIT_SHA,
  FAKE_NIXPACKS_BASE,
  FAKE_RAILPACK_BUILDER,
  FAKE_RAILPACK_RUNTIME,
  type FakeToolHandler,
  FakeTools,
} from "./fake";
export * from "./redact";
export * from "./runner";

/** Fake only when Docker itself is fake: a real daemon always gets real builds. */
export function createTools(config: Pick<Config, "driver">): ToolRunner {
  return config.driver === "fake" ? new FakeTools() : realTools;
}
