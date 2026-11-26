import type { ServiceSummary, TemplateInstall } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { projectsApi, projectsKey, projectsQuery } from "../projects/api";
import { useActionFollower } from "../services/ActionFollower";
import { installsKey, installsQuery, templatesApi } from "../templates/api";

/** The sample app: a verified template with nothing to fill in, a static site that starts in seconds. */
export const SAMPLE = { project: "apps", template: "it-tools", key: "app", service: "it-tools" } as const;

export type SampleStage = "idle" | "preparing" | "deploying" | "live" | "failed";

export interface SampleApp {
  stage: SampleStage;
  /** The install, once there is one: from this browser, or found again on the server. */
  install: TemplateInstall | null;
  service: ServiceSummary | null;
  url: string | null;
  error: string | null;
  /** When this browser asked for it, to count the seconds. Null for an install found on the server. */
  startedAt: number | null;
  start: () => Promise<void>;
}

/** What a service says about the sample's deployment, whoever started it and whenever. */
export function stageOf(service: ServiceSummary | null): SampleStage {
  if (service === null) {
    return "idle";
  }
  if (service.status === "running") {
    return "live";
  }
  if (service.activeAction !== null || service.status === "starting") {
    return "deploying";
  }
  if (service.status === "failing" || service.wake.at(-1) === "failed") {
    return "failed";
  }
  // Set up but never deployed, as after a reload in between: one click carries on.
  return "idle";
}

/** The project the guide puts new apps in, made the first time it is needed. */
export async function ensureProject(
  queryClient: ReturnType<typeof useQueryClient>,
  name: string = SAMPLE.project,
): Promise<string> {
  const { projects } = await queryClient.fetchQuery(projectsQuery);
  if (!projects.some((project) => project.name === name)) {
    await projectsApi.create({ name });
    await queryClient.invalidateQueries({ queryKey: projectsKey });
  }
  return name;
}

/**
 * The sample app, deployed from the guide in one click: the project, the install, then its deployment,
 * followed until it runs. An install made earlier, from this browser or another, is taken up again
 * rather than made twice, so a second click after a failure or a reload carries on.
 */
export function useSampleApp(enabled: boolean): SampleApp {
  const { t } = useTranslation(["onboarding", "common"]);
  const queryClient = useQueryClient();
  const follow = useActionFollower();
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const projects = useQuery({ ...projectsQuery, enabled });
  const hasProject = projects.data?.projects.some((project) => project.name === SAMPLE.project) ?? false;
  const installs = useQuery({
    ...installsQuery(SAMPLE.project),
    // Asked for at once after a click here, before the list of projects shows the new one.
    enabled: enabled && (hasProject || startedAt !== null),
    // Followed closely only while it is on its way.
    refetchInterval: (query) => {
      const found = query.state.data?.installs.find((entry) => entry.templateId === SAMPLE.template);
      const stage = stageOf(found?.components[0]?.service ?? null);
      return preparing || stage === "deploying" ? 2000 : false;
    },
  });
  const install = installs.data?.installs.find((entry) => entry.templateId === SAMPLE.template) ?? null;
  const component = install?.components[0] ?? null;
  const service = component?.service ?? null;

  const start = useCallback(async () => {
    setPreparing(true);
    setError(null);
    setStartedAt(Date.now());
    try {
      await ensureProject(queryClient);
      const { installs: existing } = await queryClient.fetchQuery(installsQuery(SAMPLE.project));
      const made =
        existing.find((entry) => entry.templateId === SAMPLE.template) ??
        (await templatesApi.install(SAMPLE.project, {
          source: { type: "catalogue", id: SAMPLE.template },
          services: { [SAMPLE.key]: { name: SAMPLE.service } },
          params: {},
        }));
      const action = await templatesApi.deploy(SAMPLE.project, made.id, { scope: "pending" });
      follow(action.id, {
        // Whether it runs is read from the service itself, which the list follows.
        success: () => void queryClient.invalidateQueries({ queryKey: installsKey(SAMPLE.project) }),
        failure: (ended) => setError(ended.error ?? t("sample.failed")),
      });
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: installsKey(SAMPLE.project) }),
        queryClient.invalidateQueries({ queryKey: projectsKey }),
      ]);
      setPreparing(false);
    }
  }, [follow, queryClient, t]);

  const derived = stageOf(service);
  const stage: SampleStage = preparing
    ? "preparing"
    : error !== null && derived !== "live" && derived !== "deploying"
      ? "failed"
      : derived;

  return {
    stage,
    install,
    service,
    url: component?.url ?? null,
    error: stage === "failed" ? (error ?? t("sample.failed")) : null,
    startedAt,
    start,
  };
}
