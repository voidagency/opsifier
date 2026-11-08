import type { AppDeps } from "../../core/context";
import { deleteHook } from "./client";
import { getGithubToken } from "./service";

/** Removes a webhook without making anything else fail: at worst it answers 404 until someone deletes it. */
export async function deleteRepositoryHook(
  deps: Pick<AppDeps, "db" | "secrets" | "logger">,
  repository: string,
  hookId: number,
): Promise<void> {
  const token = getGithubToken(deps);
  if (token === null) {
    return;
  }
  try {
    await deleteHook(token, repository, hookId);
  } catch (error) {
    deps.logger.warn({ err: error, repository }, "Could not remove a GitHub webhook");
  }
}
