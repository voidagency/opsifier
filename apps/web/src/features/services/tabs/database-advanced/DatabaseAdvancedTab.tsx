import { databaseAdvancedSettings } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Field, FormBanner, Input, Skeleton, Textarea, toast } from "../../../../ui";
import { databaseAdvancedQuery, databasesApi } from "../../../databases/api";
import { useDatabaseParams } from "../../../databases/DatabaseLayout";
import { useActionFollower } from "../../ActionFollower";
import { serviceKey } from "../../api";

/** Image, command and environment. Everything here only reaches the database through a restart. */
export function DatabaseAdvancedTab() {
  const { t } = useTranslation(["service-database-advanced", "common"]);
  const { project, engine, service } = useDatabaseParams();
  const queryClient = useQueryClient();
  const follow = useActionFollower();
  const { data, error, refetch, isPending } = useQuery(databaseAdvancedQuery(project, service));
  const hasConfigFile = engine === "mysql" || engine === "mariadb";

  const form = useForm({
    t,
    initialValues: { image: "", command: "", env: "", configFile: "" },
    validate: (values) =>
      schemaErrors(databaseAdvancedSettings, values, {
        image: values.image === "" ? t("imageRequired") : t("invalidImage"),
        env: t("invalidEnv"),
      }),
    onSubmit: async (values) => {
      const action = await databasesApi.saveAdvanced(project, service, values);
      follow(action.id, {
        success: () => toast.success(t("saved")),
        failure: (ended) => toast.error(t("failed"), ended.error ?? undefined),
      });
      toast({ title: t("restarting") });
      await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: only newly saved values reset the form
  useEffect(() => {
    if (data !== undefined) {
      form.reset(data);
    }
  }, [data?.image, data?.command, data?.env, data?.configFile]);

  if (isPending) {
    return (
      <div className="max-w-[720px] px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (data === undefined) {
    return (
      <div className="grid max-w-[520px] justify-items-start gap-3 px-4 py-6 md:px-6 lg:px-8">
        <FormBanner>{errorMessage(error, t)}</FormBanner>
        <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
      </div>
    );
  }

  return (
    <form onSubmit={form.handleSubmit} className="grid max-w-[720px] gap-5 px-4 py-6 md:px-6 lg:px-8">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <Field label={t("image")} hint={t("imageHint")} error={form.errors.image}>
        <Input {...form.field("image")} mono autoComplete="off" spellCheck={false} />
      </Field>
      <Field
        label={t("command")}
        hint={t(`commandHint.${engine === "redis" ? "redis" : "default"}`)}
        error={form.errors.command}
        optional
      >
        <Input {...form.field("command")} mono autoComplete="off" spellCheck={false} />
      </Field>
      <Field label={t("env")} hint={t("envHint")} error={form.errors.env} optional>
        <Textarea {...form.field("env")} mono rows={6} spellCheck={false} />
      </Field>
      {hasConfigFile && (
        <Field label={t("configFile")} hint={t("configFileHint")} error={form.errors.configFile} optional>
          <Textarea {...form.field("configFile")} mono rows={6} spellCheck={false} />
        </Field>
      )}
      <FormBanner tone="info">{t("restartNote")}</FormBanner>
      <div>
        <Button type="submit" variant="primary" pending={form.pending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
