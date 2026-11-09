import { rollbackActionType } from "@opsifier/contract";
import type { ActionContext, ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import type { SwarmServiceSpec } from "../../core/docker";
import { conflict } from "../../core/errors";
import { requireHostAccess } from "../access/guard";
import type { Access } from "../access/rules";
import { noteDeployment } from "../actions/repo";
import type { Mention } from "../compose/inspect";
import { assertStaysInProject } from "../projects/isolation";
import { releaseProxyFromProjectNetwork } from "../projects/network";
import { appNetworks } from "../services/compile/names";
import {
  prepareNetwork,
  releaseOutgoingImage,
  replaceRunningTasks,
  setOutgoingImageAside,
  withImage,
} from "../services/lifecycle";
import { inspectOwnedService } from "../services/ownership";
import { requireService, type ServiceTarget } from "../services/service";
import {
  activeNumberOf,
  openSnapshot,
  recordSuccess,
  refusalError,
  refusalOf,
  requireRelease,
} from "./service";

/**
 * Runs a kept version again, exactly as it ran: nothing is pulled, built or fetched, only the image
 * already on this server is used, by its ID, so that no registry can be asked and no tag can change
 * what comes back. What is saved stays saved, and the volumes are the ones in use right now.
 */
async function runRollback(
  deps: AppDeps,
  target: ServiceTarget,
  number: number,
  ctx: ActionContext,
): Promise<void> {
  const record = requireService(deps, target);
  const row = requireRelease(deps, record, number);
  const snapshot = openSnapshot(deps, row);
  const existing = await inspectOwnedService(deps, target);
  // Again, now that it is this Action's turn: all of this was read before it was queued.
  const refusal = await refusalOf(deps, row, snapshot, {
    target,
    activeNumber: activeNumberOf(deps, record),
    swarm: existing,
  });
  if (refusal !== null || existing === null) {
    throw refusalError(refusal ?? "not_deployed", number);
  }
  assertStaysInProject(deps, target, mentionsOf(snapshot.swarm));

  ctx.log(`Going back to version ${number}: ${row.image} (${row.imageId})`);
  ctx.log("Using the image already on this server. Nothing is pulled, built or fetched.");
  noteDeployment(deps.db, ctx.id, {
    rollbackOf: number,
    requestedRef: row.requestedRef,
    builtCommit: row.builtCommit,
    ociRevision: row.ociRevision,
    image: row.image,
    imageId: row.imageId,
    digest: row.digest,
  });

  await prepareNetwork(deps, target, ctx);
  const outgoing = await setOutgoingImageAside(deps, target, existing.spec, ctx);
  const { nodeId } = await deps.docker.swarmInfo();
  const pinned = withImage(snapshot.swarm, row.imageId);
  // A version says nothing about the network: it joins the project's networks of today, whichever
  // layout it was deployed on, as any deployment now would.
  const networks = appNetworks(target.projectName, target.serviceName);
  const swarmSpec = {
    ...pinned,
    TaskTemplate: {
      ...pinned.TaskTemplate,
      ForceUpdate: (existing.spec.TaskTemplate.ForceUpdate ?? 0) + 1,
      Networks: networks,
      // The kept image is on this server. Another node has nothing to run it from, and no pull is allowed.
      Placement: nodeId === null ? pinned.TaskTemplate.Placement : pinnedToNode(pinned, nodeId),
    },
  };

  const answering = await replaceRunningTasks(deps, target, ctx, {
    swarmSpec,
    compiled: { files: snapshot.files, volumes: snapshot.volumes },
    existing,
    outgoing,
    registryAuth: undefined,
  });

  ctx.log("Volumes were left as they were: their data has not gone back to that time.");
  await recordSuccess(deps, target, ctx, {
    identity: {
      ref: row.image,
      id: row.imageId,
      digest: row.digest,
      revision: row.ociRevision,
      sizeBytes: row.sizeBytes ?? 0,
    },
    swarm: swarmSpec,
    compiled: { files: snapshot.files, volumes: snapshot.volumes },
    effective: onNetworks(snapshot.effective, networks),
    requestedRef: row.requestedRef,
    builtCommit: row.builtCommit,
    rollbackOf: number,
    answering,
    desired: swarmSpec.Mode?.Replicated?.Replicas ?? 0,
  });
  await releaseOutgoingImage(deps, outgoing);
  // The same step as a deployment: it may have been the last thing the proxy was waiting for.
  await releaseProxyFromProjectNetwork(deps.docker, target.projectName, ctx.log);
}

/** What a kept version was told to connect to, read from what it really ran with. */
function mentionsOf(swarm: SwarmServiceSpec): Mention[] {
  const container = swarm.TaskTemplate.ContainerSpec;
  const variables = (container.Env ?? []).map((entry) => {
    const separator = entry.indexOf("=");
    return { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
  });
  const words = [...(container.Command ?? []), ...(container.Args ?? [])];
  return words.length === 0 ? variables : [...variables, { key: null, value: words.join(" ") }];
}

/** The applied record says what really runs, which is the project's networks of today. */
function onNetworks(effective: unknown, networks: ReturnType<typeof appNetworks>): unknown {
  const record = effective as { swarm?: { TaskTemplate?: Record<string, unknown> } };
  return record.swarm?.TaskTemplate === undefined
    ? effective
    : {
        ...record,
        swarm: { ...record.swarm, TaskTemplate: { ...record.swarm.TaskTemplate, Networks: networks } },
      };
}

/** Constraints that keep tasks on this node, without piling up across rollbacks of rollbacks. */
function pinnedToNode(spec: SwarmServiceSpec, nodeId: string): { Constraints: string[] } {
  const others = (spec.TaskTemplate.Placement?.Constraints ?? []).filter(
    (constraint) => !constraint.startsWith("node.id=="),
  );
  return { Constraints: [...others, `node.id==${nodeId}`] };
}

/** Capabilities the running version does not have. Giving those is a server administrator's decision. */
const capabilitiesRegained = (running: SwarmServiceSpec, kept: SwarmServiceSpec): string[] => {
  const held = (running.TaskTemplate.ContainerSpec.CapabilityAdd ?? []) as string[];
  return ((kept.TaskTemplate.ContainerSpec.CapabilityAdd ?? []) as string[]).filter(
    (capability) => !held.includes(capability),
  );
};

/** A person chose this version having been shown it, so everything is checked before anything queues. */
export async function enqueueRollback(
  deps: AppDeps,
  target: ServiceTarget,
  number: number,
  confirm: string,
  access: Access,
  actorEmail: string | undefined,
): Promise<ActionRow> {
  const record = requireService(deps, target);
  const row = requireRelease(deps, record, number);
  if (confirm !== target.serviceName) {
    throw conflict("confirmation_mismatch", "Type the service's exact name to confirm.", {
      confirm: "Does not match the service's name",
    });
  }
  const swarm = await inspectOwnedService(deps, target);
  const snapshot = openSnapshot(deps, row);
  const refusal = await refusalOf(deps, row, snapshot, {
    target,
    activeNumber: activeNumberOf(deps, record),
    swarm,
  });
  if (refusal !== null) {
    throw refusalError(refusal, number);
  }
  assertStaysInProject(deps, target, mentionsOf(snapshot.swarm));
  // Taken away since: an operator can no more restore it by going back than by asking for it.
  if (swarm !== null && capabilitiesRegained(swarm.spec, snapshot.swarm).length > 0) {
    requireHostAccess(access);
  }
  return deps.actions.enqueue({
    type: rollbackActionType,
    title: `Roll back ${target.projectName}/${target.serviceName} to version ${number}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run: (ctx) => runRollback(deps, target, number, ctx),
  });
}
