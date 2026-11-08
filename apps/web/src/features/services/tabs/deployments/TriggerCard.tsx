import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import { Button, FormBanner, MonoValue, toast } from "../../../../ui";
import { servicesApi, triggerQuery, useServiceParams } from "../../api";

/** The URL that starts a deployment from CI or anything else that can make a request. */
export function TriggerCard() {
  const { t } = useTranslation(["service-deployments", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const { data, isError, error } = useQuery({ ...triggerQuery(project, service), retry: false });
  const [rotating, setRotating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const rotate = async () => {
    setRotating(true);
    setFailure(null);
    try {
      await servicesApi.rotateTrigger(project, service);
      await queryClient.invalidateQueries({ queryKey: triggerQuery(project, service).queryKey });
      toast.success(t("trigger.rotated"));
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setRotating(false);
    }
  };

  if (isError && data === undefined) {
    return <FormBanner>{errorMessage(error, t)}</FormBanner>;
  }
  if (data === undefined) {
    return null;
  }

  return (
    <section className="grid max-w-[720px] gap-3 border-t pt-5">
      <div>
        <h2 className="text-md font-medium">{t("trigger.title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("trigger.description")}</p>
      </div>
      {failure !== null && <FormBanner>{failure}</FormBanner>}
      <MonoValue
        value={`${window.location.origin}${data.path}`}
        copy
        copyLabel={t("trigger.copy")}
        truncate
        className="text-sm"
      />
      <div>
        <Button size="sm" pending={rotating} onClick={rotate}>
          {t("trigger.rotate")}
        </Button>
      </div>
    </section>
  );
}
