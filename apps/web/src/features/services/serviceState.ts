import type { ServiceSummary } from "@opsifier/contract";
import type { TFunction } from "i18next";
import {
  countStates,
  type HealthCounts,
  overallState,
  type PictogramName,
  stateFromService,
  stateLanguage,
  type VisualState,
  visualStates,
} from "../../ui";
import { actionLabel } from "../activity/labels";

type ServiceLike = Pick<ServiceSummary, "status" | "activeAction" | "replicas" | "runtimeUncertain">;

/** Which state of the visual language a service is in. */
export function serviceState(service: ServiceLike): VisualState {
  return stateFromService(service);
}

/** Where a state stands in reading order: problems first. Nothing at all comes last. */
export function stateRank(state: VisualState | null): number {
  return state === null ? visualStates.length : visualStates.indexOf(state);
}

export function serviceCounts(services: readonly ServiceLike[]): HealthCounts {
  return countStates(services.map(serviceState));
}

/** The worst state among some services, or null when there are none. */
export function servicesState(services: readonly ServiceLike[]): VisualState | null {
  return overallState(serviceCounts(services));
}

/** Problems first, then by name. */
export function sortServices<T extends ServiceLike & Pick<ServiceSummary, "name">>(
  services: readonly T[],
): T[] {
  return [...services].sort(
    (a, b) => stateRank(serviceState(a)) - stateRank(serviceState(b)) || a.name.localeCompare(b.name),
  );
}

const typePictograms: Readonly<Record<string, PictogramName>> = {
  app: "app",
  compose: "compose",
  box: "box",
  wordpress: "wordpress",
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongo: "mongo",
  redis: "redis",
};

/** The pictogram for a service's type. A type the set doesn't draw yet is shown as an app. */
export function servicePictogram(type: string): PictogramName {
  return typePictograms[type] ?? "app";
}

/** The type's name, for tooltips and assistive technology. */
export function serviceTypeLabel(type: string, t: TFunction): string {
  return t(`types.${type}`, { ns: "services", defaultValue: type });
}

/** What a service's lamp says: its state's word, unless the status has a more exact one. */
export function serviceStateLabel(service: ServiceLike, t: TFunction): string {
  if (service.activeAction !== null) {
    const { type } = service.activeAction;
    return t("activeAction", { ns: "services", label: actionLabel({ type, title: type }, t) });
  }
  if (service.runtimeUncertain !== null) {
    return t("status.uncertain", { ns: "services" });
  }
  if (service.status === "undeployed" || service.status === "starting" || service.status === "unknown") {
    return t(`status.${service.status}`, { ns: "services" });
  }
  return t(stateLanguage[serviceState(service)].labelKey, { ns: "visual" });
}
