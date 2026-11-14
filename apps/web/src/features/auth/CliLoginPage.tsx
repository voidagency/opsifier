import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isApiError } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { errorMessage, useForm } from "../../lib/forms";
import { Button, ErrorState, Field, FormBanner, Input, PasswordInput, Skeleton } from "../../ui";
import { AuthLayout } from "./AuthLayout";
import { authApi, useCurrentUser } from "./session";

type Outcome = "waiting" | "approved" | "denied";

/**
 * Where a person approves `opsifier login --web`. Approving hands the command line a session of this
 * account for a day, so the page says what asks, from where, and wants the code or the password again.
 */
export function CliLoginPage() {
  const { t, i18n } = useTranslation(["auth", "common"]);
  const { code = "" } = useSearch({ strict: false }) as { code?: string };
  const user = useCurrentUser();
  const withCode = user?.twoFactorEnabled ?? false;
  const [outcome, setOutcome] = useState<Outcome>("waiting");
  const [denying, setDenying] = useState(false);
  const request = useQuery({
    queryKey: ["auth", "cli-login", code] as const,
    queryFn: () => authApi.cliLoginRequest(code),
    enabled: code !== "" && outcome === "waiting",
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const form = useForm({
    t,
    initialValues: { secret: "" },
    validate: (values) => (values.secret.trim() === "" ? { secret: t("cliLogin.required") } : {}),
    onSubmit: async (values) => {
      await authApi.approveCliLogin(
        code,
        withCode ? { code: values.secret.trim() } : { currentPassword: values.secret },
      );
      setOutcome("approved");
    },
  });

  const deny = async () => {
    setDenying(true);
    try {
      await authApi.denyCliLogin(code);
      setOutcome("denied");
    } finally {
      setDenying(false);
    }
  };

  if (outcome !== "waiting") {
    const done = outcome === "approved";
    return (
      <AuthLayout
        title={t(done ? "cliLogin.approvedTitle" : "cliLogin.deniedTitle")}
        description={t(done ? "cliLogin.approvedDescription" : "cliLogin.deniedDescription")}
      >
        {null}
      </AuthLayout>
    );
  }
  if (code === "") {
    return (
      <AuthLayout title={t("cliLogin.missingTitle")} description={t("cliLogin.missingDescription")}>
        {null}
      </AuthLayout>
    );
  }
  if (request.isPending) {
    return (
      <AuthLayout title={t("cliLogin.title")} description={null}>
        <Skeleton className="h-40" />
      </AuthLayout>
    );
  }
  if (request.isError) {
    if (isApiError(request.error) && request.error.status === 404) {
      return (
        <AuthLayout title={t("cliLogin.goneTitle")} description={t("cliLogin.goneDescription")}>
          {null}
        </AuthLayout>
      );
    }
    return (
      <AuthLayout title={t("cliLogin.title")} description={null}>
        <ErrorState message={errorMessage(request.error, t)} onRetry={() => request.refetch()} />
      </AuthLayout>
    );
  }

  const asked = request.data;
  const warning = asked.sameAddress
    ? null
    : asked.address === null
      ? t("cliLogin.unknownAddress")
      : t("cliLogin.otherAddress", { address: asked.address });
  return (
    <AuthLayout title={t("cliLogin.title")} description={t("cliLogin.description", { client: asked.client })}>
      <form onSubmit={form.handleSubmit} noValidate className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <div className="grid gap-1">
          <p className="text-sm text-muted">{t("cliLogin.codeLabel")}</p>
          <p className="font-mono text-2xl tracking-widest">{asked.userCode}</p>
          <p className="text-xs text-muted">
            {t("cliLogin.requested", { when: formatRelativeTime(asked.requestedAt, i18n.language) })}
          </p>
        </div>
        {warning && <FormBanner>{warning}</FormBanner>}
        <Field
          label={withCode ? t("twoFactor.code") : t("fields.password")}
          hint={withCode ? t("cliLogin.confirmWithCode") : t("cliLogin.confirmWithPassword")}
          error={form.errors.secret}
        >
          {withCode ? (
            <Input
              {...form.field("secret")}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
            />
          ) : (
            <PasswordInput {...form.field("secret")} autoComplete="current-password" autoFocus />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" pending={form.pending} className="w-full">
          {t("cliLogin.approve")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          pending={denying}
          onClick={() => void deny()}
        >
          {t("cliLogin.deny")}
        </Button>
      </form>
    </AuthLayout>
  );
}
