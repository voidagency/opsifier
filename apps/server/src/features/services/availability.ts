import { setTimeout as sleep } from "node:timers/promises";
import type { ActionContext } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { runInDatabase, SUCCESS_MARKER } from "../databases/exec";
import { PROXY_SERVICE } from "../projects/network";
import { listDomainRows } from "../service-tabs/domains/service";
import { qualifiedName } from "./compile";
import type { ServiceTarget } from "./service";

const SILENT_MARKER = "opsifier-silent";

/** Run in the proxy's task, so it goes over the same network the service's traffic arrives on. */
const PROBE_SCRIPT = `command -v nc >/dev/null 2>&1 || exit 0; nc -z -w 3 "$PROBE_HOST" "$PROBE_PORT" && echo ${SUCCESS_MARKER} || echo ${SILENT_MARKER}`;

/** True or false when the proxy could tell, and null when it could not even try. */
async function askProxy(deps: Pick<AppDeps, "docker">, host: string, port: number): Promise<boolean | null> {
  try {
    const { ok, output } = await runInDatabase(deps, PROXY_SERVICE, {
      command: ["sh", "-c", PROBE_SCRIPT],
      env: [`PROBE_HOST=${host}`, `PROBE_PORT=${port}`],
    });
    return ok ? true : output.includes(SILENT_MARKER) ? false : null;
  } catch {
    return null;
  }
}

/**
 * A container that started has only proved that it started. Whether anything answers on the port
 * its primary domain sends traffic to is the next thing to find out. Not answering is reported and
 * not treated as a failure: every App gets a default domain, and a background worker never answers
 * on it. Returns null when there is no domain to check, or no way to check it.
 */
export async function checkAnswering(
  deps: Pick<AppDeps, "db" | "docker" | "rollout">,
  target: ServiceTarget,
  ctx: ActionContext,
): Promise<boolean | null> {
  const primary = listDomainRows(deps.db, target).find((row) => row.isPrimary);
  if (primary === undefined) {
    return null;
  }
  const host = qualifiedName(target.projectName, target.serviceName);
  const deadline = performance.now() + deps.rollout.stableMs;
  for (;;) {
    const answer = await askProxy(deps, host, primary.port);
    if (answer === true) {
      ctx.log(`Answering on port ${primary.port}`);
      return true;
    }
    if (answer === null) {
      ctx.log("Could not check whether it answers: its tasks are running, and that is all this says.");
      return null;
    }
    if (performance.now() >= deadline) {
      ctx.log(
        `Its tasks are running, but nothing answers on port ${primary.port}. A started container does not prove the app works: check its logs and the port of its domain. A background worker has nothing to answer with, and can do without a domain.`,
      );
      return false;
    }
    await sleep(deps.rollout.pollMs, undefined, { signal: ctx.signal });
  }
}
