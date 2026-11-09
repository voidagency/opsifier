import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { Switch, toast } from "../../ui";
import { useServiceParams } from "../services/api";
import { EnvironmentTab } from "../services/tabs/environment/EnvironmentTab";
import { composeApi, composeQuery } from "./api";

/** The stack's variables, and whether they are also written to a `.env` file beside it. */
export function ComposeEnvironmentTab() {
  const { t } = useTranslation(["compose", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const { data } = useQuery(composeQuery(project, service));

  const toggle = async (enabled: boolean) => {
    try {
      const updated = await composeApi.setEnvFile(project, service, { enabled });
      queryClient.setQueryData(composeQuery(project, service).queryKey, updated);
      toast.success(t("environment.saved"), t("environment.savedHint"));
    } catch (error) {
      toast.error(errorMessage(error, t));
    }
  };

  return (
    <div className="grid">
      <EnvironmentTab />
      <section className="max-w-[1100px] px-4 pb-6 md:px-6 lg:px-8">
        <Switch
          label={t("environment.fileLabel")}
          hint={t("environment.fileHint")}
          checked={data?.envFile ?? false}
          disabled={data === undefined}
          onCheckedChange={toggle}
        />
      </section>
    </div>
  );
}
