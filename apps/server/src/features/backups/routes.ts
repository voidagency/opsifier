import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import {
  actionEntry,
  backupConfigEntry,
  backupConfigPath,
  backupRecordPath,
  backupsDocument,
  databaseNameList,
  resolveRestoreRequest,
  restoreBackupRequest,
  restoreEntry,
  restoreFromPathRequest,
  restoreRecordPath,
  runBackupRequest,
  saveBackupConfigRequest,
  servicePath,
  storageProviderOptions,
} from "@opsifier/contract";
import type { Context } from "hono";
import { toActionEntry } from "../../core/actions";
import { requirePrincipal } from "../../core/auth";
import type { AppDeps, AppEnv, Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { requestAccess } from "../access/guard";
import { requireService, type ServiceTarget } from "../services/service";
import { listProviderOptions } from "../storage-providers/service";
import { listRunningBackups, listRunningRestores, updateBackup } from "./repo";
import { recoverInterruptedRestores } from "./restore";
import { removeStoredFile } from "./run";
import { startScheduler, stopScheduler } from "./schedule";
import {
  deleteConfig,
  discardEarlierCopy,
  enqueueConfiguredBackup,
  enqueueDeleteBackup,
  getBackupsDocument,
  listDatabaseNames,
  prepareBackupDownload,
  resolveRestore,
  restoreFromBackup,
  restoreFromPath,
  saveConfig,
  toRestoreEntry,
} from "./service";

const BASE = "/api/v1/projects/{project}/services/{service}/backups";
const tags = ["Backups"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service, configuration or backup.");
const refused = errorResponse("The service is not in a state that allows this.");
const accepted = jsonResponse(actionEntry, "The Action doing the work.");

const getRoute = createRoute({
  method: "get",
  path: BASE,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(backupsDocument, "Configurations, backups and restores of this service."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const databasesRoute = createRoute({
  method: "get",
  path: `${BASE}/databases`,
  tags,
  description: "Asks the running server for its databases, to choose from in a form.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(databaseNameList, "Databases on this server."),
    401: denied,
    404: missing,
    409: refused,
  },
});

const destinationsRoute = createRoute({
  method: "get",
  path: `${BASE}/destinations`,
  tags,
  description: "The connected storage providers a form can offer.",
  request: { params: servicePath },
  responses: { 200: jsonResponse(storageProviderOptions, "Connected providers."), 401: denied, 404: missing },
});

const createConfigRoute = createRoute({
  method: "post",
  path: `${BASE}/configs`,
  tags,
  request: { params: servicePath, body: jsonBody(saveBackupConfigRequest) },
  responses: {
    201: jsonResponse(backupConfigEntry, "The saved configuration."),
    400: invalid,
    401: denied,
    404: missing,
    409: refused,
  },
});

const updateConfigRoute = createRoute({
  method: "put",
  path: `${BASE}/configs/{config}`,
  tags,
  request: { params: backupConfigPath, body: jsonBody(saveBackupConfigRequest) },
  responses: {
    200: jsonResponse(backupConfigEntry, "The saved configuration."),
    400: invalid,
    401: denied,
    404: missing,
    409: refused,
  },
});

const deleteConfigRoute = createRoute({
  method: "delete",
  path: `${BASE}/configs/{config}`,
  tags,
  description: "Removes the configuration. Files already stored stay where they are.",
  request: { params: backupConfigPath },
  responses: {
    200: jsonResponse(z.object({ id: z.string() }), "The configuration was removed."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const runRoute = createRoute({
  method: "post",
  path: `${BASE}/configs/{config}/run`,
  tags,
  description: "Takes a backup now.",
  request: { params: backupConfigPath, body: jsonBody(runBackupRequest) },
  responses: { 202: accepted, 400: invalid, 401: denied, 404: missing, 409: refused },
});

const restoreFromPathRoute = createRoute({
  method: "post",
  path: `${BASE}/restore`,
  tags,
  description: "Restores a stored file named by hand. It must have a manifest next to it.",
  request: { params: servicePath, body: jsonBody(restoreFromPathRequest) },
  responses: { 202: accepted, 400: invalid, 401: denied, 404: missing, 409: refused },
});

const restoreBackupRoute = createRoute({
  method: "post",
  path: `${BASE}/{backup}/restore`,
  tags,
  description: "Restores one recorded backup into this service.",
  request: { params: backupRecordPath, body: jsonBody(restoreBackupRequest) },
  responses: { 202: accepted, 400: invalid, 401: denied, 404: missing, 409: refused },
});

const downloadBackupRoute = createRoute({
  method: "get",
  path: `${BASE}/{backup}/download`,
  tags,
  description:
    "Sends one recorded backup, checked against its recorded size and checksum before the first byte leaves.",
  request: { params: backupRecordPath },
  responses: {
    200: {
      description: "The backup file.",
      content: {
        "application/octet-stream": { schema: z.string().openapi({ type: "string", format: "binary" }) },
      },
    },
    400: invalid,
    401: denied,
    404: missing,
    409: refused,
  },
});

const deleteBackupRoute = createRoute({
  method: "delete",
  path: `${BASE}/{backup}`,
  tags,
  description: "Deletes one stored backup. Its record stays, marked as removed.",
  request: { params: backupRecordPath },
  responses: { 202: accepted, 400: invalid, 401: denied, 404: missing, 409: refused },
});

const resolveRoute = createRoute({
  method: "post",
  path: `${BASE}/restores/{restore}/resolve`,
  tags,
  description: "Unblocks a service after a person has checked an interrupted restore.",
  request: { params: restoreRecordPath, body: jsonBody(resolveRestoreRequest) },
  responses: {
    200: jsonResponse(restoreEntry, "The restore."),
    400: invalid,
    401: denied,
    404: missing,
    409: refused,
  },
});

const discardCopyRoute = createRoute({
  method: "post",
  path: `${BASE}/restores/{restore}/discard-earlier-copy`,
  tags,
  description: "Deletes the folder holding what a volume contained before a restore.",
  request: { params: restoreRecordPath, body: jsonBody(resolveRestoreRequest) },
  responses: {
    200: jsonResponse(restoreEntry, "The restore."),
    400: invalid,
    401: denied,
    404: missing,
    409: refused,
  },
});

const target = (params: { project: string; service: string }): ServiceTarget => ({
  projectName: params.project,
  serviceName: params.service,
});

const actorOf = (c: Context<AppEnv>): string => requirePrincipal(c).user.email;

async function recoverAtBoot(deps: AppDeps): Promise<void> {
  const reason = "The panel restarted while this backup was running.";
  for (const row of listRunningBackups(deps.db)) {
    updateBackup(deps.db, row.id, { status: "failed", error: reason, finishedAt: new Date(deps.now()) });
    if (row.storageProviderId !== null) {
      // Best effort: a destination might still hold the half-written file of a run that died.
      void removeStoredFile(deps, { ...row, path: `${row.path}.partial` }).catch(() => {});
    }
  }
  await recoverInterruptedRestores(deps, listRunningRestores(deps.db));
}

export const feature: Feature = {
  async boot(deps) {
    await recoverAtBoot(deps);
    startScheduler(deps);
  },

  shutdown(deps) {
    stopScheduler(deps);
  },

  register(app, deps) {
    app.openapi(getRoute, (c) => c.json(getBackupsDocument(deps, target(c.req.valid("param"))), 200));

    app.openapi(databasesRoute, async (c) =>
      c.json(await listDatabaseNames(deps, target(c.req.valid("param"))), 200),
    );

    app.openapi(destinationsRoute, (c) => {
      requireService(deps, target(c.req.valid("param")));
      return c.json(listProviderOptions(deps), 200);
    });

    app.openapi(createConfigRoute, (c) =>
      c.json(saveConfig(deps, target(c.req.valid("param")), c.req.valid("json"), null, actorOf(c)), 201),
    );

    app.openapi(updateConfigRoute, (c) => {
      const params = c.req.valid("param");
      return c.json(saveConfig(deps, target(params), c.req.valid("json"), params.config, actorOf(c)), 200);
    });

    app.openapi(deleteConfigRoute, (c) => {
      const params = c.req.valid("param");
      deleteConfig(deps, target(params), params.config, actorOf(c));
      return c.json({ id: params.config }, 200);
    });

    app.openapi(runRoute, (c) => {
      const params = c.req.valid("param");
      const { name } = c.req.valid("json");
      return c.json(
        toActionEntry(
          enqueueConfiguredBackup(deps, target(params), params.config, {
            origin: "manual",
            name: name ?? null,
            actorEmail: actorOf(c),
          }),
        ),
        202,
      );
    });

    app.openapi(restoreFromPathRoute, async (c) =>
      c.json(
        toActionEntry(
          await restoreFromPath(
            deps,
            target(c.req.valid("param")),
            c.req.valid("json"),
            requestAccess(deps, c),
            actorOf(c),
          ),
        ),
        202,
      ),
    );

    app.openapi(restoreBackupRoute, async (c) => {
      const params = c.req.valid("param");
      return c.json(
        toActionEntry(
          await restoreFromBackup(deps, target(params), params.backup, c.req.valid("json"), actorOf(c)),
        ),
        202,
      );
    });

    app.openapi(downloadBackupRoute, async (c) => {
      const params = c.req.valid("param");
      const download = await prepareBackupDownload(
        deps,
        target(params),
        params.backup,
        actorOf(c),
        c.req.raw.signal,
      );
      const body = createReadStream(download.file);
      // However this ends, finished or cut off by the client, the working folder goes with it.
      body.once("close", () => {
        void download.discard().catch(() => {});
      });
      return c.body(Readable.toWeb(body) as ReadableStream<Uint8Array>, 200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(download.sizeBytes),
        "Content-Disposition": `attachment; filename="${download.fileName}"`,
        "Cache-Control": "no-store",
        "X-Backup-Sha256": download.sha256,
      });
    });

    app.openapi(deleteBackupRoute, (c) => {
      const params = c.req.valid("param");
      return c.json(toActionEntry(enqueueDeleteBackup(deps, target(params), params.backup, actorOf(c))), 202);
    });

    app.openapi(resolveRoute, (c) => {
      const params = c.req.valid("param");
      return c.json(
        toRestoreEntry(
          resolveRestore(deps, target(params), params.restore, c.req.valid("json").confirm, actorOf(c)),
        ),
        200,
      );
    });

    app.openapi(discardCopyRoute, async (c) => {
      const params = c.req.valid("param");
      return c.json(
        toRestoreEntry(
          await discardEarlierCopy(
            deps,
            target(params),
            params.restore,
            c.req.valid("json").confirm,
            actorOf(c),
          ),
        ),
        200,
      );
    });
  },
};
