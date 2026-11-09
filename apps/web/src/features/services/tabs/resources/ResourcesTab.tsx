import { type ResourcesSpec, resourcesSpec } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { errorMessage, schemaErrors, useForm } from "../../../../lib/forms";
import { Button, ErrorState, Field, FormBanner, Input, SectionIntro, Skeleton, toast } from "../../../../ui";
import { useServiceParams } from "../../api";
import { resourcesApi, resourcesQuery } from "./api";

type FieldName = keyof ResourcesSpec;

const fields: ReadonlyArray<{ name: FieldName; step: string }> = [
  { name: "memoryReservation", step: "1" },
  { name: "memoryLimit", step: "1" },
  { name: "cpuReservation", step: "0.01" },
  { name: "cpuLimit", step: "0.01" },
];

const toText = (values: ResourcesSpec) => ({
  memoryReservation: String(values.memoryReservation),
  memoryLimit: String(values.memoryLimit),
  cpuReservation: String(values.cpuReservation),
  cpuLimit: String(values.cpuLimit),
});

function parsed(values: Record<FieldName, string>): ResourcesSpec {
  return {
    memoryReservation: Number(values.memoryReservation),
    memoryLimit: Number(values.memoryLimit),
    cpuReservation: Number(values.cpuReservation),
    cpuLimit: Number(values.cpuLimit),
  };
}

function ResourcesForm({
  project,
  service,
  initial,
}: {
  project: string;
  service: string;
  initial: ResourcesSpec;
}) {
  const { t } = useTranslation("service-resources");
  const queryClient = useQueryClient();
  const form = useForm({
    t,
    initialValues: toText(initial),
    validate: (values) => {
      const empty = fields.filter(({ name }) => values[name].trim() === "");
      if (empty.length > 0) {
        return Object.fromEntries(empty.map(({ name }) => [name, t(`errors.${name}`)]));
      }
      return schemaErrors<FieldName>(resourcesSpec, parsed(values), {
        memoryReservation: t("errors.memoryReservation"),
        memoryLimit: t("errors.memoryLimit"),
        cpuReservation: t("errors.cpuReservation"),
        cpuLimit: t("errors.cpuLimit"),
      });
    },
    onSubmit: async (values) => {
      const saved = await resourcesApi.save(project, service, parsed(values));
      queryClient.setQueryData(resourcesQuery(project, service).queryKey, saved);
      toast.success(t("saved"), t("savedHint"));
    },
  });

  return (
    <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[650px] gap-4">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(({ name, step }) => (
          <Field
            key={name}
            label={t(`fields.${name}`)}
            error={form.errors[name]}
            hint={t(`fieldHints.${name}`)}
          >
            <Input {...form.field(name)} mono type="number" min="0" step={step} inputMode="decimal" />
          </Field>
        ))}
      </div>
      <p className="text-sm text-muted">{t("hint")}</p>
      <div>
        <Button type="submit" variant="primary" pending={form.pending}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

export function ResourcesTab() {
  const { t } = useTranslation(["service-resources", "common"]);
  const { project, service } = useServiceParams();
  const { data, isPending, isError, error, refetch } = useQuery(resourcesQuery(project, service));

  return (
    <section className="grid gap-x-10 gap-y-4 px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,620px)] lg:px-8">
      <SectionIntro pictogram="cpu" title={t("title")} description={t("description")} />
      {isPending ? (
        <Skeleton className="h-40" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : (
        <ResourcesForm key={service} project={project} service={service} initial={data} />
      )}
    </section>
  );
}
