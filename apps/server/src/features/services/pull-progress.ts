import type { ActionContext } from "../../core/actions";
import type { PullProgress } from "../../core/docker";

/** Downloads repeat for every chunk. Only the steps worth reading afterwards are kept in the log. */
const NOISY_PULL_STATUSES =
  /^(Downloading|Extracting|Waiting|Verifying Checksum|Pulling fs layer|Download complete)/;

/** What a pull says, for an Action's log, each line once. */
export function logPullProgress(ctx: Pick<ActionContext, "log">): (progress: PullProgress) => void {
  const seen = new Set<string>();
  return ({ status, id }) => {
    if (NOISY_PULL_STATUSES.test(status)) {
      return;
    }
    const line = id === undefined ? status : `${id}: ${status}`;
    if (!seen.has(line)) {
      seen.add(line);
      ctx.log(line);
    }
  };
}
