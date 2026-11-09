import type { ServiceDetail, ServiceSource } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import { Button, FormBanner, Switch, toast } from "../../../../ui";
import { serviceKey, servicesApi, triggerQuery } from "../../api";
import { sourceApi } from "./api";

type GithubSource = Extract<ServiceSource, { type: "github" }>;

/** Deploys on every push to the configured branch, through a webhook on the repository. */
export function AutoDeploySection({
  project,
  service,
  source,
  githubConfigured,
}: {
  project: string;
  service: string;
  source: GithubSource;
  githubConfigured: boolean;
}) {
  const { t } = useTranslation(["service-source", "common"]);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const trigger = useQuery({ ...triggerQuery(project, service), enabled: source.autoDeploy, retry: false });
  const webhook = trigger.data?.webhook ?? null;

  const toggle = async (enabled: boolean) => {
    setPending(true);
    setFailure(null);
    try {
      const saved = await sourceApi.setAutoDeploy(project, service, { enabled });
      queryClient.setQueryData<ServiceDetail>(serviceKey(project, service), (current) =>
        current === undefined ? current : { ...current, source: saved },
      );
      toast.success(enabled ? t("autoDeploy.enabled") : t("autoDeploy.disabled"));
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setPending(false);
    }
  };

  const renew = async () => {
    setPending(true);
    setFailure(null);
    try {
      await servicesApi.rotateWebhook(project, service);
      await queryClient.invalidateQueries({ queryKey: triggerQuery(project, service).queryKey });
      toast.success(t("autoDeploy.renewed"));
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="grid gap-3 border-t pt-4">
      <h3 className="text-md font-medium">{t("autoDeploy.title")}</h3>
      {failure !== null && <FormBanner>{failure}</FormBanner>}
      {webhook !== null && (webhook.paused || webhook.legacy) && (
        <div className="grid gap-2">
          <FormBanner tone="warning">
            {webhook.paused ? t("autoDeploy.pausedTitle") : t("autoDeploy.legacyHook")}
          </FormBanner>
          <div>
            <Button size="sm" pending={pending} onClick={renew}>
              {t("autoDeploy.renew")}
            </Button>
          </div>
        </div>
      )}
      {githubConfigured ? (
        <Switch
          label={t("autoDeploy.label", { branch: source.ref })}
          hint={t("autoDeploy.hint")}
          checked={source.autoDeploy}
          disabled={pending}
          onCheckedChange={toggle}
        />
      ) : (
        <p className="text-sm text-muted">
          {t("autoDeploy.needsToken")}{" "}
          <Link to="/settings/server/github" className="underline underline-offset-2">
            {t("github.tokenLink")}
          </Link>
        </p>
      )}
    </section>
  );
}
