import { AsyncLocalStorage } from "node:async_hooks";
import type { ActionOrigin } from "@opsifier/contract";

/** Where a piece of work came from: the request that asked for it, or the panel itself. */
export interface ActionSource {
  origin: ActionOrigin;
  /** The account behind it, when there is one. */
  actorEmail?: string;
  /** What the origin leaves out, such as the name of an API key or the commit a push announced. */
  detail?: string;
}

const ambient = new AsyncLocalStorage<ActionSource>();

/** Every Action `work` creates, however deep in the call stack, says it came from `source`. */
export const runAs = <T>(source: ActionSource, work: () => T): T => ambient.run(source, work);

/** Undefined outside any request or Action: timers, boot, what the panel does on its own. */
export const currentSource = (): ActionSource | undefined => ambient.getStore();
