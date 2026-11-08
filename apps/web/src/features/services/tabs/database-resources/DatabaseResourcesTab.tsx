import { resourcesSpec } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Field, FormBanner, Input, Skeleton, toast } from "../../../../ui";
import { databaseResourcesQuery, databasesApi } from "../../../databases/api";
import { useDatabaseParams } from "../../../databases/DatabaseLayout";
import { useActionFollower } from "../../ActionFollower";
import { serviceKey } from "../../api";

const fields = ["memoryReservation", "memoryLimit", "cpuReservation", "cpuLimit"] as const;
type Values = Record<(typeof fields)[number], string>;

/** Limits and reservations. Saving applies them at once, as the page says. */
export function DatabaseResourcesTab() {
  const { t } = useTranslation(["service-database-resources", "common"]);
  const { project, service } = useDatabaseParams();
  const queryClient = useQueryClient();
  const follow = useActionFollower();
  const { data, error, refetch, isPending } = useQuery(databaseResourcesQuery(project, service));

  const toNumbers = (values: Values) => ({
    memoryReservation: Number(values.memoryReservation),
    memoryLimit: Number(values.memoryLimit),
    cpuReservation: Number(values.cpuReservation),
    cpuLimit: Number(values.cpuLimit),
  });

  const form = useForm<Values>({
    t,
    initialValues: { memoryReservation: "0", memoryLimit: "0", cpuReservation: "0", cpuLimit: "0" },
    validate: (values) =>
      schemaErrors(resourcesSpec, toNumbers(values), {
        memoryReservation: t("invalid"),
        memoryLimit: t("invalid"),
        cpuReservation: t("invalid"),
        cpuLimit: t("invalid"),
      }),
    onSubmit: async (values) => {
      const action = await databasesApi.saveResources(project, service, toNumbers(values));
      follow(action.id, {
        success: () => toast.success(t("saved")),
        failure: (ended) => toast.error(t("failed"), ended.error ?? undefined),
      });
      toast({ title: t("restarting") });
      await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a newly saved value resets the form
  useEffect(() => {
    if (data !== undefined) {
      form.reset({
        memoryReservation: String(data.memoryReservation),
        memoryLimit: String(data.memoryLimit),
        cpuReservation: String(data.cpuReservation),
        cpuLimit: String(data.cpuLimit),
      });
    }
  }, [data?.memoryReservation, data?.memoryLimit, data?.cpuReservation, data?.cpuLimit]);

  if (isPending) {
    return (
      <div className="max-w-[640px] px-4 py-6 md:px-6 lg:px-8">
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
    <form onSubmit={form.handleSubmit} className="grid max-w-[640px] gap-5 px-4 py-6 md:px-6 lg:px-8">
      <p className="max-w-[60ch] text-muted">{t("intro")}</p>
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("memoryReservation")} error={form.errors.memoryReservation}>
          <Input {...form.field("memoryReservation")} inputMode="decimal" mono autoComplete="off" />
        </Field>
        <Field label={t("memoryLimit")} error={form.errors.memoryLimit}>
          <Input {...form.field("memoryLimit")} inputMode="decimal" mono autoComplete="off" />
        </Field>
        <Field label={t("cpuReservation")} error={form.errors.cpuReservation}>
          <Input {...form.field("cpuReservation")} inputMode="decimal" mono autoComplete="off" />
        </Field>
        <Field label={t("cpuLimit")} error={form.errors.cpuLimit}>
          <Input {...form.field("cpuLimit")} inputMode="decimal" mono autoComplete="off" />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="primary" pending={form.pending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
