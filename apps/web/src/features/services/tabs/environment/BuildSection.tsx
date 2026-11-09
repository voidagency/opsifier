import { buildSecretName } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../../../lib/format";
import { errorMessage, useForm } from "../../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  ErrorState,
  Field,
  FormBanner,
  Input,
  PasswordInput,
  SectionIntro,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
  toast,
} from "../../../../ui";
import { buildEnvironmentQuery, serviceKey, servicesApi } from "../../api";
import { VariablesEditor } from "./VariablesEditor";

function SecretsTable({
  project,
  service,
  secrets,
  onChanged,
}: {
  project: string;
  service: string;
  secrets: ReadonlyArray<{ name: string; updatedAt: string }>;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation(["service-environment", "common"]);
  const [removing, setRemoving] = useState<string | null>(null);

  if (secrets.length === 0) {
    return <p className="text-sm text-muted">{t("build.secrets.empty")}</p>;
  }
  return (
    <>
      <Table>
        <THead>
          <TR>
            <TH>{t("build.secrets.name")}</TH>
            <TH>{t("build.secrets.updated")}</TH>
            <TH />
          </TR>
        </THead>
        <TBody>
          {secrets.map((secret) => (
            <TR key={secret.name}>
              <TD mono className="break-all">
                {secret.name}
              </TD>
              <TD className="text-muted">{formatDateTime(secret.updatedAt, i18n.language)}</TD>
              <TD numeric>
                <Tooltip content={t("build.secrets.remove", { name: secret.name })}>
                  <button
                    type="button"
                    onClick={() => setRemoving(secret.name)}
                    aria-label={t("build.secrets.remove", { name: secret.name })}
                    className="inline-flex size-6 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </button>
                </Tooltip>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
          }
        }}
        title={t("build.secrets.removeTitle", { name: removing ?? "" })}
        description={t("build.secrets.removeHint")}
        confirmLabel={t("build.secrets.removeConfirm")}
        onConfirm={async () => {
          await servicesApi.deleteBuildSecret(project, service, removing as string);
          toast.success(t("build.secrets.removed"));
          onChanged();
        }}
      />
    </>
  );
}

function SecretForm({
  project,
  service,
  onChanged,
}: {
  project: string;
  service: string;
  onChanged: () => void;
}) {
  const { t } = useTranslation(["service-environment", "common"]);
  const form = useForm({
    t,
    initialValues: { name: "", value: "" },
    validate: (values) => ({
      ...(buildSecretName.safeParse(values.name).success ? {} : { name: t("build.secrets.nameInvalid") }),
      ...(values.value === "" ? { value: t("build.secrets.valueRequired") } : {}),
    }),
    onSubmit: async (values) => {
      await servicesApi.saveBuildSecret(project, service, values.name, values.value);
      form.reset({ name: "", value: "" });
      toast.success(t("build.secrets.saved"), t("savedHint"));
      onChanged();
    },
  });

  return (
    <form
      onSubmit={form.handleSubmit}
      noValidate
      className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start"
    >
      {form.banner && <FormBanner className="sm:col-span-3">{form.banner}</FormBanner>}
      <Field label={t("build.secrets.name")} hint={t("build.secrets.nameHint")} error={form.errors.name}>
        <Input {...form.field("name")} mono autoComplete="off" spellCheck={false} placeholder="NPM_TOKEN" />
      </Field>
      <Field label={t("build.secrets.value")} hint={t("build.secrets.valueHint")} error={form.errors.value}>
        <PasswordInput {...form.field("value")} autoComplete="new-password" />
      </Field>
      <Button type="submit" pending={form.pending} className="sm:mt-7">
        {t("build.secrets.submit")}
      </Button>
    </form>
  );
}

/** What the next build is given. None of it comes from the variables above. */
export function BuildSection({ project, service }: { project: string; service: string }) {
  const { t } = useTranslation(["service-environment", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(buildEnvironmentQuery(project, service));
  const [stopping, setStopping] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: [...serviceKey(project, service), "environment"] });
  };

  if (isPending) {
    return <Skeleton className="h-40" />;
  }
  if (isError) {
    return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }

  return (
    <div className="grid gap-6">
      {data.inheritsRuntime && (
        <FormBanner tone="warning" title={t("build.inherited.title")}>
          <div className="grid justify-items-start gap-2">
            <p>{t("build.inherited.body")}</p>
            <Button type="button" onClick={() => setStopping(true)}>
              {t("build.inherited.stop")}
            </Button>
          </div>
        </FormBanner>
      )}
      <div className="grid gap-3">
        <SectionIntro
          pictogram="environment"
          title={t("build.variables.title")}
          description={t("build.variables.hint")}
        />
        <VariablesEditor
          names={data.variables}
          label={t("build.variables.title")}
          submitLabel={t("build.variables.submit")}
          savedTitle={t("build.variables.saved")}
          savedHint={t("savedHint")}
          reveal={() => servicesApi.revealBuildVariables(project, service)}
          save={(env) => servicesApi.saveBuildVariables(project, service, env)}
          onSaved={refresh}
        />
      </div>
      <div className="grid gap-3">
        <SectionIntro
          pictogram="access"
          title={t("build.secrets.title")}
          description={t("build.secrets.hint")}
        />
        <SecretsTable project={project} service={service} secrets={data.secrets} onChanged={refresh} />
        <SecretForm project={project} service={service} onChanged={refresh} />
      </div>
      <ConfirmDialog
        open={stopping}
        onOpenChange={setStopping}
        title={t("build.inherited.confirmTitle")}
        description={t("build.inherited.confirmBody")}
        confirmLabel={t("build.inherited.stop")}
        onConfirm={async () => {
          await servicesApi.stopInheritingRuntime(project, service);
          toast.success(t("build.inherited.stopped"), t("savedHint"));
          refresh();
        }}
      />
    </div>
  );
}
