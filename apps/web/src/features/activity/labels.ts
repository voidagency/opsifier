import type { ActionEntry } from "@opsifier/contract";
import type { TFunction } from "i18next";
import type { PictogramName } from "../../ui";

const typePictograms: Readonly<Record<string, PictogramName>> = {
  "service.deploy": "deployment",
  "service.rollback": "restore",
  "service.source": "git",
  "service.env": "environment",
  "project.env": "environment",
  "service.env-reveal": "environment",
  "project.env-reveal": "environment",
  "service.domains": "domain",
  "service.redirects": "redirect",
  "service.security": "access",
  "service.maintenance": "maintenance",
  "service.console": "console",
  "service.scripts": "console",
  "service.script": "console",
  "service.resources": "cpu",
  "service.mounts": "volume",
  "service.deploy-settings": "settings",
  "service.ports": "port",
  "database.password": "access",
  "database.password-recovery": "access",
  "database.reveal": "access",
  "database.expose": "port",
  "database.settings": "settings",
};

const familyPictograms: Readonly<Record<string, PictogramName>> = {
  auth: "user",
  project: "template",
  service: "app",
  database: "postgres",
  backup: "backup",
  domain: "domain",
  certificate: "certificate",
  template: "template",
  compose: "compose",
  system: "node",
};

/** What an action is about, drawn: by its type, then by the kind of thing it acts on. */
export function actionPictogram(type: string): PictogramName {
  return typePictograms[type] ?? familyPictograms[type.split(".")[0] ?? ""] ?? "activity";
}

/** The interface's words for an action, falling back to the title stored with it. */
export function actionLabel(action: Pick<ActionEntry, "type" | "title">, t: TFunction): string {
  return t(`types.${action.type}`, { ns: "activity", defaultValue: action.title });
}

/** The step an action is on, or the last one it reached. Null for work too short to have steps. */
export function actionPhase(action: Pick<ActionEntry, "phase">, t: TFunction): string | null {
  return action.phase === null
    ? null
    : t(`phases.${action.phase}`, { ns: "activity", defaultValue: action.phase });
}

export function actionTarget(action: Pick<ActionEntry, "projectName" | "serviceName">): string | null {
  return action.projectName === null
    ? null
    : action.serviceName === null
      ? action.projectName
      : `${action.projectName}/${action.serviceName}`;
}
