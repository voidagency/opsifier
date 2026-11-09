import { changePasswordRequest, type DatabaseCredentials } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Dialog, Field, FormBanner, PasswordInput, toast } from "../../../../ui";
import { databasesApi } from "../../../databases/api";
import { generateStrongPassword } from "../../../databases/password";
import { useActionFollower } from "../../ActionFollower";
import { serviceKey } from "../../api";

/** Only the secret can change. User and database name are fixed when the database is created. */
export function ChangePasswordDialog({
  project,
  service,
  hasRootPassword,
  open,
  onOpenChange,
  onChanged,
}: {
  project: string;
  service: string;
  hasRootPassword: DatabaseCredentials["hasRootPassword"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the new password is in effect. */
  onChanged?: () => void;
}) {
  const { t } = useTranslation(["service-credentials", "common"]);
  const queryClient = useQueryClient();
  const follow = useActionFollower();

  const form = useForm({
    t,
    initialValues: { password: "", rootPassword: "" },
    validate: (values) => {
      const typed = {
        ...(values.password === "" ? {} : { password: values.password }),
        ...(values.rootPassword === "" ? {} : { rootPassword: values.rootPassword }),
      };
      if (values.password === "" && values.rootPassword === "") {
        return { password: t("change.required") };
      }
      return schemaErrors(changePasswordRequest, typed, {
        password: t("change.invalid"),
        rootPassword: t("change.invalid"),
      });
    },
    onSubmit: async (values) => {
      const action = await databasesApi.changePassword(project, service, {
        ...(values.password === "" ? {} : { password: values.password }),
        ...(values.rootPassword === "" ? {} : { rootPassword: values.rootPassword }),
      });
      follow(action.id, {
        success: () => {
          toast.success(t("change.done"));
          onChanged?.();
        },
        failure: (ended) => toast.error(t("change.failed"), ended.error ?? undefined),
      });
      toast({ title: t("change.started") });
      await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
      onOpenChange(false);
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts empty
  useEffect(() => {
    if (open) {
      form.reset({ password: "", rootPassword: "" });
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={t("change.title")}
      description={t("change.description")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("change.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("change.password")} error={form.errors.password} hint={t("change.passwordHint")}>
          <PasswordInput {...form.field("password")} autoComplete="new-password" autoFocus />
        </Field>
        {hasRootPassword && (
          <Field
            label={t("change.rootPassword")}
            hint={t("change.rootHint")}
            error={form.errors.rootPassword}
            optional
          >
            <PasswordInput {...form.field("rootPassword")} autoComplete="new-password" />
          </Field>
        )}
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => form.set("password", generateStrongPassword())}
          >
            {t("change.generate")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
