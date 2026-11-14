import { createRoute } from "@hono/zod-openapi";
import {
  actionEntry,
  revealServerBackupKeyRequest,
  saveServerBackupRequest,
  serverBackupKey,
  serverBackupSaved,
  serverBackupSnapshots,
  serverBackupState,
} from "@opsifier/contract";
import { toActionEntry } from "../../core/actions";
import { requireSessionPrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { createAuthService } from "../auth/service";
import { resumeServerRestore } from "./restore";
import {
  listServerSnapshots,
  revealRecoveryKey,
  saveServerBackup,
  settleInterruptedRun,
  startServerBackup,
  startServerBackupSchedule,
  serverBackupState as stateOf,
} from "./service";

const PATH = "/api/v1/server/backup";
const tags = ["Server backup"];
const denied = errorResponse("Not signed in.");
const refused = errorResponse("Only the owner, or an administrator the owner has allowed, can do this.");
const invalid = errorResponse("The request failed validation.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  summary: "Show the server backup's settings and last run",
  responses: { 200: jsonResponse(serverBackupState, "The settings."), 401: denied, 403: refused },
});

const saveRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  summary: "Change the server backup",
  description:
    "The first time a destination is set, the panel creates an encrypted restic repository there and its recovery key, returned in this answer only.",
  request: { body: jsonBody(saveServerBackupRequest) },
  responses: {
    200: jsonResponse(serverBackupSaved, "The settings, and the recovery key when this created it."),
    400: invalid,
    401: denied,
    403: refused,
    409: errorResponse("The destination is not connected, or already holds a repository."),
  },
});

const runRoute = createRoute({
  method: "post",
  path: `${PATH}/run`,
  tags,
  summary: "Back up the server now",
  responses: {
    202: jsonResponse(actionEntry, "The Action that backs up the server."),
    401: denied,
    403: refused,
    409: errorResponse("Not set up yet, or the server is being restored."),
  },
});

const snapshotsRoute = createRoute({
  method: "get",
  path: `${PATH}/snapshots`,
  tags,
  summary: "List the server's backups",
  responses: {
    200: jsonResponse(serverBackupSnapshots, "Newest first."),
    401: denied,
    403: refused,
    409: errorResponse("Not set up yet."),
  },
});

const keyRoute = createRoute({
  method: "post",
  path: `${PATH}/key`,
  tags,
  summary: "Show the recovery key again",
  description:
    "The person proves who they are again: with their two-factor code when they have one, else their password.",
  request: { body: jsonBody(revealServerBackupKeyRequest) },
  responses: {
    200: jsonResponse(serverBackupKey, "The recovery key."),
    400: invalid,
    401: denied,
    403: refused,
    409: errorResponse("Not set up yet."),
    429: errorResponse("Too many attempts."),
  },
});

let stopSchedule: (() => void) | undefined;

export const feature: Feature = {
  boot: (deps) => {
    settleInterruptedRun(deps);
    stopSchedule = startServerBackupSchedule(deps);
  },
  // A restore deploys, so it waits for every feature to have booted: some tidy what deployments use.
  ready: resumeServerRestore,
  shutdown: () => {
    stopSchedule?.();
    stopSchedule = undefined;
  },

  register(app, deps) {
    const auth = createAuthService(deps);

    app.openapi(getRoute, (c) => c.json(stateOf(deps), 200));

    app.openapi(saveRoute, async (c) => {
      const principal = requireSessionPrincipal(c);
      return c.json(await saveServerBackup(deps, c.req.valid("json"), principal.user.email), 200);
    });

    app.openapi(runRoute, (c) => {
      const principal = requireSessionPrincipal(c);
      return c.json(toActionEntry(startServerBackup(deps, principal.user.email)), 202);
    });

    app.openapi(snapshotsRoute, async (c) => c.json(await listServerSnapshots(deps), 200));

    app.openapi(keyRoute, async (c) => {
      const principal = requireSessionPrincipal(c);
      await auth.confirmIdentity(principal, c.req.valid("json"));
      const recoveryKey = revealRecoveryKey(deps);
      deps.actions.record({
        type: "backup.config",
        title: "Showed the server backup's recovery key",
        actorEmail: principal.user.email,
      });
      return c.json({ recoveryKey }, 200);
    });
  },
};
