import { type ServiceSource, saveSourceRequest } from "@opsifier/contract";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Field, FormBanner, Input, PasswordInput } from "../../../../ui";
import { type SourceSectionProps, useSaveSource } from "./SourceFormShared";

type ImageSource = Extract<ServiceSource, { type: "image" }>;

const initialFrom = (source: ImageSource | null) => ({
  image: source?.image ?? "",
  username: source?.username ?? "",
  password: "",
});

/** The image to run and how to reach a private registry. The API never sends a stored password back. */
export function ImageSourceForm({
  project,
  service,
  source,
  onSaved,
  submitLabel,
  autoFocus,
}: SourceSectionProps & { autoFocus: boolean }) {
  const { t } = useTranslation("service-source");
  const saved = source?.type === "image" ? source : null;
  const hasPassword = saved?.hasPassword ?? false;
  const { save } = useSaveSource({ project, service, onSaved });

  const form = useForm({
    t,
    initialValues: initialFrom(saved),
    validate: (values) => {
      const errors = schemaErrors<"image" | "username" | "password">(
        saveSourceRequest,
        {
          type: "image",
          image: values.image,
          username: values.username || undefined,
          password: values.password || undefined,
        },
        { image: values.image.trim() === "" ? t("errors.imageRequired") : t("errors.imageInvalid") },
      );
      if (values.username.trim() === "" && values.password !== "") {
        errors.username = t("errors.usernameRequired");
      }
      if (values.username.trim() !== "" && values.password === "" && !hasPassword) {
        errors.password = t("errors.passwordRequired");
      }
      return errors;
    },
    onSubmit: async (values) => {
      const result = await save({
        image: values.image,
        username: values.username,
        ...(values.password === "" ? {} : { password: values.password }),
      });
      form.reset(initialFrom(result as ImageSource));
    },
  });

  return (
    <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[520px] gap-4">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <Field label={t("image")} hint={t("imageHint")} error={form.errors.image}>
        <Input
          {...form.field("image")}
          mono
          placeholder="name:tag"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
        />
      </Field>
      <fieldset className="m-0 grid gap-4 border-0 p-0">
        <legend className="mb-1 text-xs text-muted">{t("registryHint")}</legend>
        <Field label={t("username")} optional error={form.errors.username}>
          <Input {...form.field("username")} mono autoComplete="off" spellCheck={false} />
        </Field>
        <Field
          label={t("password")}
          optional
          hint={hasPassword ? t("passwordStored") : undefined}
          error={form.errors.password}
        >
          <PasswordInput
            {...form.field("password")}
            autoComplete="new-password"
            placeholder={hasPassword ? t("passwordPlaceholder") : undefined}
          />
        </Field>
      </fieldset>
      <div>
        <Button type="submit" variant="primary" pending={form.pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
