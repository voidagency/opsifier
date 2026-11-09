import { exposeSettings } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, useForm } from "../../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  ErrorState,
  Field,
  FormBanner,
  Input,
  Lamp,
  SectionIntro,
  Skeleton,
  toast,
} from "../../../../ui";
import { databaseQuery, databasesApi, exposeQuery } from "../../../databases/api";
import { useDatabaseParams } from "../../../databases/DatabaseLayout";
import { serviceKey, serviceQuery } from "../../api";
import { serviceState, serviceStateLabel } from "../../serviceState";

/** Publishes the database on a port of the server, from its next deployment on. */
export function ExposeTab() {
  const { t } = useTranslation(["service-expose", "services", "visual", "activity", "common"]);
  const { project, service } = useDatabaseParams();
  const queryClient = useQueryClient();
  const { data, error, refetch, isPending } = useQuery(exposeQuery(project, service));
  const { data: database } = useQuery(databaseQuery(project, service));
  const { data: detail } = useQuery(serviceQuery(project, service));
  const [confirming, setConfirming] = useState(false);
  // Set while the confirmed submit runs, so that a conflict lands on the field, not in the dialog.
  const confirmedRisk = useRef(false);

  const submit = async (port: number) => {
    await databasesApi.saveExpose(project, service, { port });
    toast.success(port === 0 ? t("removed") : t("exposed", { port }), t("savedHint"));
    await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
  };

  const form = useForm({
    t,
    initialValues: { port: "0" },
    validate: ({ port }) =>
      exposeSettings.safeParse({ port: Number(port) }).success ? {} : { port: t("invalid") },
    onSubmit: async ({ port }) => {
      const value = Number(port);
      if (value > 0 && value !== (data?.port ?? 0) && !confirmedRisk.current) {
        setConfirming(true);
        return;
      }
      confirmedRisk.current = false;
      await submit(value);
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new saved value resets the field
  useEffect(() => {
    if (data !== undefined) {
      form.reset({ port: String(data.port) });
    }
  }, [data?.port]);

  if (isPending) {
    return (
      <div className="max-w-[650px] px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (data === undefined) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="grid max-w-[800px] gap-5 px-4 py-6 md:px-6 lg:px-8">
      <SectionIntro
        pictogram="port"
        title={
          data.publishedPort !== null && data.publishedPort > 0 && detail !== undefined ? (
            <Lamp
              state={serviceState(detail)}
              label={`${t("state.on", { port: data.publishedPort })} · ${serviceStateLabel(detail, t)}`}
              showLabel
            />
          ) : (
            <Lamp state="stopped" label={t("state.off")} showLabel />
          )
        }
        description={t("intro", { port: database?.internalPort ?? "" })}
      />
      <FormBanner tone="warning" title={t("warning.title")}>
        {t("warning.description")}
      </FormBanner>
      {data.port > 0 && data.publishedPort !== null && data.publishedPort !== data.port && (
        <FormBanner tone="info">{t("notPublishedYet", { port: data.port })}</FormBanner>
      )}
      <form onSubmit={form.handleSubmit} className="grid max-w-[400px] gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("port")} hint={t("hint")} error={form.errors.port}>
          <Input {...form.field("port")} inputMode="numeric" mono autoComplete="off" />
        </Field>
        <div>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("save")}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("confirm.title")}
        description={t("confirm.description", { port: form.values.port })}
        confirmLabel={t("confirm.submit")}
        tone="primary"
        onConfirm={() => {
          confirmedRisk.current = true;
          setConfirming(false);
          void form.handleSubmit();
        }}
      />
    </div>
  );
}
