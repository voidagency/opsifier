import { isSshRemote } from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";
import { repositoryKey } from "./identity";

/**
 * The first repository a deploy key is used for claims it, for good. Called by anything that is about
 * to use it, because a key can be generated for a source that was saved long ago.
 */
export function claimDeployKey(
  deps: Pick<AppDeps, "db" | "now">,
  target: ServiceTarget,
  remote: string,
): void {
  const record = requireService(deps, target);
  const key = record.spec.build.sshKey;
  if (key !== null && key.boundTo === null && isSshRemote(remote)) {
    saveServiceSpec(
      deps.db,
      target.projectName,
      target.serviceName,
      { ...record.spec, build: { ...record.spec.build, sshKey: { ...key, boundTo: repositoryKey(remote) } } },
      new Date(deps.now()),
    );
  }
}
