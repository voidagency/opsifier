import type { ActionContext, ActionRun } from "../../core/actions";

/** What a request to deploy asks for beyond "deploy what is saved". */
export interface DeployRequest {
  /** Skip every build cache. Image sources have none, so it changes nothing for them. */
  force?: boolean;
  /** Build exactly this commit, instead of what the source's ref points at. */
  commit?: string;
}

type RequestedRun = ActionRun & { request: DeployRequest };
type DeployWork = (request: DeployRequest, ctx: ActionContext) => Promise<void>;

/** A deployment's run, remembering what it was asked for so that a later request can add to it. */
export function deployRun(request: DeployRequest, work: DeployWork): RequestedRun {
  return Object.assign((ctx: ActionContext) => work(request, ctx), { request });
}

/**
 * For a request joining a deployment that is still waiting: a forced rebuild is never lost, and the
 * newest request decides what gets built, so a push announcing the latest commit wins over an older one.
 */
export function joinDeployRun(waiting: ActionRun, later: DeployRequest, work: DeployWork): ActionRun {
  const earlier = (waiting as Partial<RequestedRun>).request;
  return deployRun({ force: earlier?.force === true || later.force === true, commit: later.commit }, work);
}
