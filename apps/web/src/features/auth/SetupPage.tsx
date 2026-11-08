import { passwordMaxLength, setupRequest } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../lib/forms";
import { Button, Field, FormBanner, Input, PasswordInput } from "../../ui";
import { AuthLayout } from "./AuthLayout";
import { applySession, authApi } from "./session";

export function SetupPage() {
  const { t } = useTranslation("auth");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { token } = useSearch({ from: "/setup" });
  const [askForCode, setAskForCode] = useState(token === undefined);

  const form = useForm({
    t,
    initialValues: { token: token ?? "", email: "", password: "" },
    validate: (values) =>
      schemaErrors(setupRequest, values, {
        token: t("errors.setupCode"),
        email: t("errors.email"),
        password:
          values.password.length > passwordMaxLength
            ? t("errors.passwordTooLong", { max: passwordMaxLength })
            : t("errors.passwordLength"),
      }),
    onSubmit: async (values) => {
      applySession(queryClient, await authApi.setup(values));
      await navigate({ to: "/", replace: true });
    },
  });

  // A link that turns out to be stale needs somewhere to enter the right code.
  const codeError = form.errors.token;
  useEffect(() => {
    if (codeError) {
      setAskForCode(true);
    }
  }, [codeError]);

  return (
    <AuthLayout title={t("setup.title")} description={t("setup.description")}>
      <form onSubmit={form.handleSubmit} noValidate className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        {askForCode && (
          <Field label={t("setup.code")} hint={t("setup.codeHint")} error={codeError}>
            <Input
              {...form.field("token")}
              mono
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
          </Field>
        )}
        <Field label={t("fields.email")} error={form.errors.email}>
          <Input
            {...form.field("email")}
            type="email"
            autoComplete="username"
            autoFocus={!askForCode}
            spellCheck={false}
          />
        </Field>
        <Field label={t("fields.password")} hint={t("setup.passwordHint")} error={form.errors.password}>
          <PasswordInput {...form.field("password")} autoComplete="new-password" />
        </Field>
        <Button type="submit" variant="primary" size="lg" pending={form.pending} className="mt-2 w-full">
          {t("setup.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
