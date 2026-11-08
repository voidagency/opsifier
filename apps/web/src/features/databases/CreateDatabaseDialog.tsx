import { createDatabaseRequest, type DatabaseEngine, databaseEngineInfo } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../lib/forms";
import { Button, Dialog, Field, FormBanner, Input, PasswordInput, toast } from "../../ui";
import { projectsKey } from "../projects/api";
import { databasesApi } from "./api";

const blank = {
  name: "",
  databaseName: "",
  user: "",
  password: "",
  rootPassword: "",
  image: "",
};

/** One dialog for every engine: a field only appears when that engine has it. */
export function CreateDatabaseDialog({
  project,
  engine,
  open,
  onOpenChange,
}: {
  project: string;
  engine: DatabaseEngine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["databases", "common"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const info = databaseEngineInfo[engine];

  const form = useForm({
    t,
    initialValues: blank,
    validate: (values) =>
      schemaErrors(
        createDatabaseRequest,
        { ...values, engine },
        {
          name: values.name === "" ? t("create.required") : t("create.invalidName"),
          databaseName: t("create.invalidDatabaseName"),
          user: t("create.invalidUser"),
          password: t("create.invalidPassword"),
          rootPassword: t("create.invalidPassword"),
          image: t("create.invalidImage"),
        },
      ),
    onSubmit: async (values) => {
      await databasesApi.create(project, { ...values, engine });
      await queryClient.invalidateQueries({ queryKey: projectsKey });
      onOpenChange(false);
      toast.success(t("create.created", { name: values.name }));
      await navigate({
        to: "/projects/$project/$engine/$service/",
        params: { project, engine, service: values.name },
      });
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts from a clean form
  useEffect(() => {
    if (open) {
      form.reset(blank);
    }
  }, [open, engine]);

  const engineName = t(`engines.${engine}`);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={t("create.title", { engine: engineName })}
      description={t("create.description", { project })}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("create.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("create.name")} hint={t("create.nameHint")} error={form.errors.name}>
          <Input {...form.field("name")} mono autoFocus autoComplete="off" spellCheck={false} />
        </Field>
        {info.hasDatabaseName && (
          <Field
            label={t("create.databaseName")}
            hint={t("create.databaseNameHint", { project })}
            error={form.errors.databaseName}
            optional
          >
            <Input
              {...form.field("databaseName")}
              mono
              placeholder={project}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}
        {info.customUser && (
          <Field
            label={t("create.user")}
            hint={t("create.userHint", { user: info.defaultUser })}
            error={form.errors.user}
            optional
          >
            <Input
              {...form.field("user")}
              mono
              placeholder={info.defaultUser}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}
        <Field
          label={t("create.password")}
          hint={t("create.passwordHint")}
          error={form.errors.password}
          optional
        >
          <PasswordInput {...form.field("password")} autoComplete="new-password" />
        </Field>
        {info.hasRootPassword && (
          <Field
            label={t("create.rootPassword")}
            hint={t("create.passwordHint")}
            error={form.errors.rootPassword}
            optional
          >
            <PasswordInput {...form.field("rootPassword")} autoComplete="new-password" />
          </Field>
        )}
        <Field
          label={t("create.image")}
          hint={t("create.imageHint", { image: info.defaultImage })}
          error={form.errors.image}
          optional
        >
          <Input
            {...form.field("image")}
            mono
            placeholder={info.defaultImage}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </div>
    </Dialog>
  );
}
