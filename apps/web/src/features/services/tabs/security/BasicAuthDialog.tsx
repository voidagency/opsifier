import { type BasicAuthEntry, createBasicAuthRequest, updateBasicAuthRequest } from "@opsifier/contract";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Dialog, Field, FormBanner, Input, PasswordInput, toast } from "../../../../ui";
import { basicAuthApi } from "./api";

export interface BasicAuthDialogProps {
  project: string;
  service: string;
  /** The entry being edited, or undefined to create one. */
  entry?: BasicAuthEntry;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

/** The password is write-only: the field always starts empty, and blank means "keep it". */
export function BasicAuthDialog({ project, service, entry, onClose, onSaved }: BasicAuthDialogProps) {
  const { t } = useTranslation(["service-security", "common"]);
  const form = useForm({
    t,
    initialValues: { username: entry?.username ?? "", password: "" },
    validate: (values) => {
      if (entry === undefined) {
        return schemaErrors<"username" | "password">(createBasicAuthRequest, values, {
          username: t("errors.username"),
          password: t("errors.password"),
        });
      }
      return schemaErrors<"username" | "password">(
        updateBasicAuthRequest,
        { username: values.username, password: values.password === "" ? undefined : values.password },
        { username: t("errors.username"), password: t("errors.password") },
      );
    },
    onSubmit: async (values) => {
      if (entry === undefined) {
        await basicAuthApi.create(project, service, values);
      } else {
        await basicAuthApi.update(project, service, entry.id, {
          username: values.username,
          ...(values.password === "" ? {} : { password: values.password }),
        });
      }
      await onSaved();
      toast.success(t("saved"));
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="sm"
      title={entry === undefined ? t("dialog.createTitle") : t("dialog.updateTitle")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {entry === undefined ? t("dialog.create") : t("dialog.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("dialog.username")} error={form.errors.username}>
          <Input
            {...form.field("username")}
            mono
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
          />
        </Field>
        <Field
          label={t("dialog.password")}
          hint={entry === undefined ? undefined : t("dialog.passwordKeep")}
          error={form.errors.password}
        >
          <PasswordInput {...form.field("password")} autoComplete="new-password" />
        </Field>
      </div>
    </Dialog>
  );
}
