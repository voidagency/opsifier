import { exposeSettings } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, useForm } from "../../../../lib/forms";
import { Button, ConfirmDialog, Field, FormBanner, Input, Skeleton, toast } from "../../../../ui";
import { databaseQuery, databasesApi, exposeQuery } from "../../../databases/api";
import { useDatabaseParams } from "../../../databases/DatabaseLayout";
import { useActionFollower } from "../../ActionFollower";
import { serviceKey } from "../../api";

/** Publishes the database on a port of the server. Saving restarts it, as the tab says. */
export function ExposeTab() {
  const { t } = useTranslation(["service-expose", "common"]);
  const { project, service } = useDatabaseParams();
  const queryClient = useQueryClient();
  const follow = useActionFollower();
  const { data, error, refetch, isPending } = useQuery(exposeQuery(project, service));
  const { data: database } = useQuery(databaseQuery(project, service));
  const [confirming, setConfirming] = useState(false);
  // Set while the confirmed submit runs, so that a conflict lands on the field, not in the dialog.
  const confirmedRisk = useRef(false);

  const submit = async (port: number) => {
    const action = await databasesApi.saveExpose(project, service, { port });
    follow(action.id, {
      success: () => toast.success(port === 0 ? t("removed") : t("exposed", { port })),
      failure: (ended) => toast.error(t("failed"), ended.error ?? undefined),
    });
    toast({ title: t("restarting") });
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
      <div className="max-w-[520px] px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-16" />
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
    <div className="grid max-w-[640px] gap-5 px-4 py-6 md:px-6 lg:px-8">
      <p className="max-w-[60ch] text-muted">{t("intro", { port: database?.internalPort ?? "" })}</p>
      <FormBanner tone="warning" title={t("warning.title")}>
        {t("warning.description")}
      </FormBanner>
      <form onSubmit={form.handleSubmit} className="grid max-w-[320px] gap-4">
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
