import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type ApplyPanelUpdateRequest,
  type PanelRelease,
  type PanelUpdateOutcome,
  type PanelUpdateStatus,
  panelRollbackConfirm,
  panelUpdateConfirm,
  type RollbackPanelRequest,
} from "@opsifier/contract";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { PANEL_ROLLBACK_CONFIG, PANEL_SWARM_SERVICE, PANEL_UPDATE_CONFIG } from "../../bootstrap/specs";
import type { ActionContext, ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import type { ServiceInfo, SwarmServiceSpec } from "../../core/docker";
import { conflict, serviceUnavailable } from "../../core/errors";
import {
  clearJournal,
  hasSnapshot,
  pruneSnapshots,
  readJournal,
  SNAPSHOT_DATABASE,
  saveSnapshotKey,
  snapshotDir,
  type UpdateJournal,
  writeJournal,
} from "./journal";
import { compareVersions, isVersion } from "./version";

/** How often a page load may cause a real look at the release feed. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10_000;
const MAX_FEED_BYTES = 1024 * 1024;

const releaseFeed = z.object({
  version: z.string().refine(isVersion, "Not a version"),
  image: z.string().min(1).max(512),
  notes: z.string().max(100_000).default(""),
  migrations: z.array(z.string().max(1000)).max(200).default([]),
  publishedAt: z.string().max(64).nullable().default(null),
});

/** `repo:tag@digest` without the tag and digest. Registry hosts may carry a port, tags never a slash. */
export function repositoryOf(image: string): string {
  const withoutDigest = image.split("@", 1)[0] ?? image;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function withImage(spec: SwarmServiceSpec, image: string): SwarmServiceSpec {
  return {
    ...spec,
    TaskTemplate: {
      ...spec.TaskTemplate,
      ContainerSpec: { ...spec.TaskTemplate.ContainerSpec, Image: image },
    },
    // Set again at every update, in case the service came from a setup older than this rule.
    UpdateConfig: PANEL_UPDATE_CONFIG,
    RollbackConfig: PANEL_ROLLBACK_CONFIG,
  };
}

interface CheckState {
  attemptedAt: number | null;
  checkedAt: string | null;
  latest: PanelRelease | null;
  error: string | null;
  running: Promise<void> | null;
}

/**
 * Everything about the panel replacing itself. The Action started here ends in a different process,
 * so `journal.ts` is what carries it across: the old version writes down what it is doing just before
 * handing over to Swarm, and the next one to start, whichever it is, reads what happened.
 */
export class PanelUpdates {
  private readonly checks: CheckState = {
    attemptedAt: null,
    checkedAt: null,
    latest: null,
    error: null,
    running: null,
  };
  private verification: NodeJS.Timeout | undefined;

  constructor(private readonly deps: AppDeps) {
    // The Action of the update outlives this process: `recover` must leave it for `boot` to finish.
    deps.actions.claimInterrupted((row) => {
      const journal = readJournal(deps.config);
      return journal !== null && !journal.concluded && journal.actionId === row.id;
    });
  }

  /** The release feed is only ever fetched from here: there is no call from the browser. */
  async check(): Promise<void> {
    if (this.checks.running === null) {
      this.checks.running = this.fetchLatest().finally(() => {
        this.checks.running = null;
      });
    }
    await this.checks.running;
  }

  async status(): Promise<PanelUpdateStatus> {
    this.refreshIfStale();
    const { config } = this.deps;
    const panel = await this.panelService();
    const journal = readJournal(config);
    const { latest } = this.checks;

    return {
      activeVersion: config.version,
      managed: panel !== null,
      deployedImage: panel?.spec.TaskTemplate.ContainerSpec.Image ?? null,
      latest,
      updateAvailable: latest !== null && compareVersions(latest.version, config.version) > 0,
      checkedAt: this.checks.checkedAt,
      checkError: this.checks.error,
      checksEnabled: config.releasesUrl !== null,
      inProgress:
        journal !== null && (journal.state === "applying" || journal.state === "verifying")
          ? {
              kind: journal.kind,
              toVersion: journal.toVersion,
              state: journal.state,
              actionId: journal.actionId,
            }
          : null,
      last: journal === null ? null : toOutcome(journal),
      rollback: this.rollbackOption(journal),
    };
  }

  /** Runs as soon as the new process can serve: after `recover`, before accepting requests. */
  boot(): void {
    const { config, logger } = this.deps;
    const journal = readJournal(config);
    if (journal === null || journal.concluded) {
      return;
    }

    if (journal.state === "rolled-back") {
      this.finish(journal, "failed", journal.error ?? "The update did not take.");
      return;
    }
    if (journal.state !== "applying" && journal.state !== "verifying") {
      return;
    }
    if (config.version !== journal.toVersion) {
      logger.warn(
        { version: config.version, target: journal.toVersion },
        "This update never reached its version",
      );
      this.finish(
        journal,
        "failed",
        `Version ${journal.toVersion} did not start, so the panel stayed on ${config.version}.`,
      );
      return;
    }

    // The right version is running. It still has to stay up for as long as Swarm is watching it.
    const verifying: UpdateJournal = { ...journal, state: "verifying" };
    writeJournal(config, verifying);
    this.deps.actions.note(
      journal.actionId ?? journal.id,
      `Version ${journal.toVersion} started. Watching it for now.`,
    );
    this.verification = setTimeout(() => this.finish(verifying, "succeeded", null), config.updateVerifyMs);
    this.verification.unref();
  }

  shutdown(): void {
    clearTimeout(this.verification);
  }

  async apply(request: ApplyPanelUpdateRequest, actorEmail: string | undefined): Promise<ActionRow> {
    if (request.confirm !== panelUpdateConfirm) {
      throw conflict("confirmation_mismatch", `Type ${panelUpdateConfirm} to confirm.`, {
        confirm: "Does not match",
      });
    }
    const { latest } = this.checks;
    if (latest === null || latest.version !== request.version) {
      throw conflict("update_unavailable", "This version is not the one on offer. Check for updates again.");
    }
    if (compareVersions(latest.version, this.deps.config.version) <= 0) {
      throw conflict("up_to_date", `The panel is already on ${this.deps.config.version}.`);
    }
    await this.requirePanelService();

    return this.deps.actions.enqueue({
      type: "panel.update",
      title: `Update the panel to ${latest.version}`,
      actorEmail,
      run: (ctx) => this.runUpdate(latest, ctx),
    });
  }

  async rollback(request: RollbackPanelRequest, actorEmail: string | undefined): Promise<ActionRow> {
    if (request.confirm !== panelRollbackConfirm) {
      throw conflict("confirmation_mismatch", `Type ${panelRollbackConfirm} to confirm.`, {
        confirm: "Does not match",
      });
    }
    const journal = readJournal(this.deps.config);
    if (journal === null || this.rollbackOption(journal) === null) {
      throw conflict("nothing_to_roll_back", "There is no earlier version to go back to.");
    }
    await this.requirePanelService();
    // Asking Docker first: a rollback that can't find its image must fail before anything changes.
    if ((await this.deps.docker.inspectImage(journal.fromImage)) === null) {
      throw conflict(
        "rollback_image_missing",
        `The image of version ${journal.fromVersion} is no longer on this server. Nothing was changed.`,
      );
    }

    return this.deps.actions.enqueue({
      type: "panel.rollback",
      title: `Go back to version ${journal.fromVersion}`,
      actorEmail,
      run: (ctx) => this.runRollback(journal, ctx),
    });
  }

  private rollbackOption(journal: UpdateJournal | null): PanelUpdateStatus["rollback"] {
    const { config } = this.deps;
    if (
      journal === null ||
      journal.kind !== "update" ||
      journal.state !== "succeeded" ||
      config.version !== journal.toVersion ||
      !hasSnapshot(config, journal.snapshotId)
    ) {
      return null;
    }
    return {
      version: journal.fromVersion,
      restoresData: this.migrationCount() !== journal.migrationsAtSnapshot,
      savedAt: journal.startedAt,
    };
  }

  private refreshIfStale(): void {
    const { attemptedAt } = this.checks;
    if (attemptedAt === null || this.deps.now() - attemptedAt > CHECK_INTERVAL_MS) {
      void this.check();
    }
  }

  private async fetchLatest(): Promise<void> {
    const { config, now } = this.deps;
    this.checks.attemptedAt = now();
    if (config.releasesUrl === null) {
      return;
    }
    try {
      const response = await fetch(config.releasesUrl, {
        headers: { accept: "application/json", "user-agent": "opsifier" },
        redirect: "follow",
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`the feed answered ${response.status}`);
      }
      const body = await response.text();
      if (body.length > MAX_FEED_BYTES) {
        throw new Error("the feed is too large");
      }
      this.checks.latest = releaseFeed.parse(JSON.parse(body));
      this.checks.error = null;
    } catch (error) {
      this.deps.logger.warn({ err: error }, "Could not check for a new version");
      this.checks.error = `The release feed could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.checks.checkedAt = new Date(now()).toISOString();
  }

  private async panelService(): Promise<ServiceInfo | null> {
    try {
      return await this.deps.docker.inspectService(PANEL_SWARM_SERVICE);
    } catch (error) {
      this.deps.logger.warn({ err: error }, "Could not look up the panel's service");
      return null;
    }
  }

  private async requirePanelService(): Promise<ServiceInfo> {
    const panel = await this.panelService();
    if (panel === null) {
      throw serviceUnavailable(
        "not_managed",
        "The panel does not run as a Swarm service here, so it cannot update itself.",
      );
    }
    return panel;
  }

  private migrationCount(): number {
    const row = this.deps.db.get<{ applied: number }>(
      sql`SELECT count(*) AS applied FROM __drizzle_migrations`,
    );
    return row?.applied ?? 0;
  }

  /** A copy of the state as it is now, next to the key it was encrypted with. */
  private takeSnapshot(id: string): void {
    const { config, db } = this.deps;
    const directory = snapshotDir(config, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const partial = join(directory, `${SNAPSHOT_DATABASE}.partial`);
    // `VACUUM INTO` is one consistent snapshot, however busy the database is.
    db.run(sql.raw(`VACUUM INTO '${partial.replaceAll("'", "''")}'`));
    chmodSync(partial, 0o600);
    renameSync(partial, join(directory, SNAPSHOT_DATABASE));
    saveSnapshotKey(config, id);
  }

  private async runUpdate(release: PanelRelease, ctx: ActionContext): Promise<void> {
    const { config, docker } = this.deps;
    const panel = await this.requirePanelService();
    const image = panel.spec.TaskTemplate.ContainerSpec.Image;
    if (repositoryOf(image) !== repositoryOf(release.image)) {
      throw new Error(
        `The release feed offers ${release.image}, which is not this panel's image ${repositoryOf(image)}.`,
      );
    }

    ctx.log(`Pulling ${release.image}`);
    await docker.pullImage(release.image, { signal: ctx.signal });
    const delivered = await docker.inspectImage(release.image);
    if (delivered === null) {
      throw new Error(`${release.image} is not on the server after pulling it.`);
    }
    const digest = delivered.digests[0] ?? delivered.id;
    ctx.log(`Delivered ${digest} (${Math.round(delivered.sizeBytes / 1024 / 1024)} MiB)`);
    ctx.signal.throwIfAborted();

    ctx.log("Saving the panel's database and key");
    const snapshotId = nanoid();
    this.takeSnapshot(snapshotId);
    pruneSnapshots(config);

    const journal: UpdateJournal = {
      id: nanoid(),
      actionId: ctx.id,
      kind: "update",
      state: "applying",
      fromVersion: config.version,
      fromImage: image,
      toVersion: release.version,
      toImage: release.image,
      digest,
      sizeBytes: delivered.sizeBytes,
      snapshotId,
      migrationsAtSnapshot: this.migrationCount(),
      restoreData: false,
      startedAt: new Date(this.deps.now()).toISOString(),
      finishedAt: null,
      error: null,
      concluded: false,
    };
    writeJournal(config, journal);

    ctx.log(`Replacing the panel with ${release.version}`);
    try {
      await docker.updateService(PANEL_SWARM_SERVICE, withImage(panel.spec, release.image));
    } catch (error) {
      clearJournal(config);
      rmSync(snapshotDir(config, snapshotId), { recursive: true, force: true });
      throw error;
    }
    ctx.handOver();
  }

  private async runRollback(previous: UpdateJournal, ctx: ActionContext): Promise<void> {
    const { config, docker } = this.deps;
    const panel = await this.requirePanelService();
    const restoreData = this.migrationCount() !== previous.migrationsAtSnapshot;
    if (restoreData) {
      ctx.log(`The data will go back to how it was at ${previous.startedAt}`);
    }
    writeJournal(config, {
      ...previous,
      id: nanoid(),
      actionId: ctx.id,
      kind: "rollback",
      state: "applying",
      fromVersion: config.version,
      fromImage: panel.spec.TaskTemplate.ContainerSpec.Image,
      toVersion: previous.fromVersion,
      toImage: previous.fromImage,
      restoreData,
      startedAt: new Date(this.deps.now()).toISOString(),
      finishedAt: null,
      error: null,
      concluded: false,
    });

    ctx.log(`Replacing the panel with ${previous.fromVersion}`);
    try {
      await docker.updateService(PANEL_SWARM_SERVICE, withImage(panel.spec, previous.fromImage));
    } catch (error) {
      writeJournal(config, previous);
      throw error;
    }
    ctx.handOver();
  }

  private finish(journal: UpdateJournal, result: "succeeded" | "failed", error: string | null): void {
    const { config, actions } = this.deps;
    writeJournal(config, {
      ...journal,
      state:
        result === "succeeded" ? "succeeded" : journal.state === "rolled-back" ? "rolled-back" : "failed",
      error,
      finishedAt: new Date(this.deps.now()).toISOString(),
      concluded: true,
    });
    if (journal.actionId !== null) {
      actions.note(
        journal.actionId,
        result === "succeeded" ? `Running on ${journal.toVersion}.` : `Failed: ${error}`,
      );
      actions.conclude(
        journal.actionId,
        result === "succeeded" ? { status: "succeeded" } : { status: "failed", error: error ?? undefined },
      );
    }
  }
}

function toOutcome(journal: UpdateJournal): PanelUpdateOutcome | null {
  if (journal.state === "applying" || journal.state === "verifying") {
    return null;
  }
  return {
    kind: journal.kind,
    result: journal.state === "rolled-back" ? "rolled-back" : journal.state,
    fromVersion: journal.fromVersion,
    toVersion: journal.toVersion,
    digest: journal.digest,
    sizeBytes: journal.sizeBytes,
    finishedAt: journal.finishedAt,
    message: journal.error,
  };
}

const instances = new WeakMap<AppDeps, PanelUpdates>();

/** One per runtime, shared by the routes and the boot hook that run at different moments. */
export function panelUpdates(deps: AppDeps): PanelUpdates {
  let instance = instances.get(deps);
  if (instance === undefined) {
    instance = new PanelUpdates(deps);
    instances.set(deps, instance);
  }
  return instance;
}
