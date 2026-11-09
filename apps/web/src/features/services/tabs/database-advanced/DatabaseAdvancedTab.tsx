import { isFixedDatabaseImage, isMajorVersionChange, saveDatabaseAdvancedRequest } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isApiError } from "../../../../lib/api";
import { errorMessage, schemaErrors, useForm } from "../../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  ErrorState,
  Field,
  FormBanner,
  Input,
  Skeleton,
  Textarea,
  toast,
} from "../../../../ui";
import { databaseAdvancedQuery, databasesApi } from "../../../databases/api";
import { useDatabaseParams } from "../../../databases/DatabaseLayout";
import { serviceKey, servicesApi } from "../../api";

interface AdvancedValues {
  image: string;
  command: string;
  env: string;
  configFile: string;
}

/** Image, command and environment, which reach the database at its next deployment. */
export function DatabaseAdvancedTab() {
  const { t } = useTranslation(["service-database-advanced", "common"]);
  const { project, engine, service } = useDatabaseParams();
  const queryClient = useQueryClient();
  const { data, error, refetch, isPending } = useQuery(databaseAdvancedQuery(project, service));
  const hasConfigFile = engine === "mysql" || engine === "mariadb";
  // The values of its variables are only fetched when asked for: sending none leaves them as they are.
  const [envOpen, setEnvOpen] = useState(false);
  const [revealFailure, setRevealFailure] = useState<string | null>(null);
  const showEnv = envOpen || data?.envNames.length === 0;
  const [majorChange, setMajorChange] = useState<AdvancedValues | null>(null);

  const save = async ({ env, ...values }: AdvancedValues, confirm?: string) => {
    await databasesApi.saveAdvanced(project, service, {
      ...values,
      ...(showEnv ? { env } : {}),
      confirm,
    });
    toast.success(t("saved"), t("savedHint"));
    await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
  };

  const form = useForm({
    t,
    initialValues: { image: "", command: "", env: "", configFile: "" } satisfies AdvancedValues,
    validate: (values) => {
      const errors = schemaErrors(saveDatabaseAdvancedRequest, values, {
        image: values.image === "" ? t("imageRequired") : t("invalidImage"),
        env: t("invalidEnv"),
      });
      if (errors.image === undefined && values.image !== data?.image && !isFixedDatabaseImage(values.image)) {
        errors.image = t("fixedImage");
      }
      return errors;
    },
    onSubmit: async (values) => {
      if (data !== undefined && isMajorVersionChange(data.image, values.image)) {
        setMajorChange(values);
        return;
      }
      try {
        await save(values);
      } catch (error) {
        // Another tab or a stale page: the server knows better what is saved now.
        if (isApiError(error) && error.code === "major_version_change") {
          setMajorChange(values);
          return;
        }
        throw error;
      }
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: only newly saved values reset the form
  useEffect(() => {
    if (data !== undefined) {
      form.reset({ image: data.image, command: data.command, env: "", configFile: data.configFile });
      setEnvOpen(false);
    }
  }, [data?.image, data?.command, data?.envNames.join(), data?.configFile]);

  const revealEnv = async () => {
    setRevealFailure(null);
    try {
      form.set("env", (await servicesApi.revealEnvironment(project, service)).env);
      setEnvOpen(true);
    } catch (cause) {
      setRevealFailure(errorMessage(cause, t));
    }
  };

  if (isPending) {
    return (
      <div className="max-w-[900px] px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-32" />
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
    <form onSubmit={form.handleSubmit} className="grid max-w-[900px] gap-5 px-4 py-6 md:px-6 lg:px-8">
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
        {showEnv ? (
          <Textarea {...form.field("env")} mono rows={6} spellCheck={false} />
        ) : (
          <div className="grid justify-items-start gap-2">
            <p className="break-all font-mono text-sm">{data.envNames.join(", ")}</p>
            <Button type="button" onClick={() => void revealEnv()}>
              <Eye aria-hidden="true" className="size-4" />
              {t("envReveal")}
            </Button>
            {revealFailure && <FormBanner>{revealFailure}</FormBanner>}
          </div>
        )}
      </Field>
      {hasConfigFile && (
        <Field label={t("configFile")} hint={t("configFileHint")} error={form.errors.configFile} optional>
          <Textarea {...form.field("configFile")} mono rows={6} spellCheck={false} />
        </Field>
      )}
      <FormBanner tone="info">{t("deployNote")}</FormBanner>
      <div>
        <Button type="submit" variant="primary" pending={form.pending}>
          {t("save")}
        </Button>
      </div>
      <ConfirmDialog
        open={majorChange !== null}
        onOpenChange={(open) => !open && setMajorChange(null)}
        title={t("majorChange.title")}
        description={t(engine === "redis" ? "majorChange.descriptionRedis" : "majorChange.description", {
          from: data.image,
          to: majorChange?.image ?? "",
        })}
        confirmLabel={t("majorChange.confirm")}
        confirmText={service}
        onConfirm={async () => {
          if (majorChange !== null) {
            await save(majorChange, service);
            setMajorChange(null);
          }
        }}
      />
    </form>
  );
}
