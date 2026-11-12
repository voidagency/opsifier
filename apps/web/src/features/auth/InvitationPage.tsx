import { acceptInvitationRequest, passwordMaxLength } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { isApiError } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { errorMessage, schemaErrors, useForm } from "../../lib/forms";
import { Button, buttonClass, ErrorState, Field, FormBanner, Input, PasswordInput, Skeleton } from "../../ui";
import { AuthLayout } from "./AuthLayout";
import { applySession, authApi } from "./session";

const accountFields = acceptInvitationRequest.pick({ name: true, password: true });

/** The token travels in the fragment: a browser never sends that part to a server, so no log holds it. */
function tokenFrom(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, "")).trim();
  } catch {
    return "";
  }
}

/** Where someone invited chooses their name and password, and creates their account. */
export function InvitationPage() {
  const { t, i18n } = useTranslation(["auth", "common"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const token = tokenFrom(useLocation().hash);
  const preview = useQuery({
    queryKey: ["auth", "invitation", token] as const,
    queryFn: () => authApi.checkInvitation({ token }),
    enabled: token !== "",
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const form = useForm({
    t,
    initialValues: { name: "", password: "" },
    validate: (values) =>
      schemaErrors(accountFields, values, {
        name: t("errors.name"),
        password:
          values.password.length > passwordMaxLength
            ? t("errors.passwordTooLong", { max: passwordMaxLength })
            : t("errors.passwordLength"),
      }),
    onSubmit: async (values) => {
      applySession(queryClient, await authApi.acceptInvitation({ token, ...values }));
      await navigate({ to: "/", replace: true });
    },
  });

  const unusable =
    token === "" ||
    (preview.isError && isApiError(preview.error) && preview.error.code === "invitation_invalid");
  if (unusable) {
    return (
      <AuthLayout title={t("invitation.invalidTitle")} description={t("invitation.invalidDescription")}>
        <Link to="/login" className={buttonClass("secondary", "md")}>
          {t("invitation.toLogin")}
        </Link>
      </AuthLayout>
    );
  }
  if (preview.isPending) {
    return (
      <AuthLayout title={t("invitation.title")} description={t("invitation.checking")}>
        <Skeleton className="h-40" />
      </AuthLayout>
    );
  }
  if (preview.isError) {
    return (
      <AuthLayout title={t("invitation.title")} description={t("invitation.unreachable")}>
        <ErrorState message={errorMessage(preview.error, t)} onRetry={() => preview.refetch()} />
      </AuthLayout>
    );
  }

  const invitation = preview.data;
  return (
    <AuthLayout
      title={t("invitation.title")}
      description={t(invitation.role === "admin" ? "invitation.asAdmin" : "invitation.asMember", {
        inviter: invitation.invitedBy,
      })}
    >
      <form onSubmit={form.handleSubmit} noValidate className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("fields.email")} hint={t("invitation.emailHint")}>
          <Input value={invitation.email} readOnly type="email" autoComplete="username" />
        </Field>
        <Field label={t("fields.name")} error={form.errors.name} hint={t("fields.nameHint")}>
          <Input {...form.field("name")} autoComplete="name" autoFocus />
        </Field>
        <Field label={t("fields.password")} hint={t("invitation.passwordHint")} error={form.errors.password}>
          <PasswordInput {...form.field("password")} autoComplete="new-password" />
        </Field>
        <Button type="submit" variant="primary" size="lg" pending={form.pending} className="mt-2 w-full">
          {t("invitation.submit")}
        </Button>
        <p className="text-sm text-muted">
          {t("invitation.expires", { when: formatRelativeTime(invitation.expiresAt, i18n.language) })}
        </p>
      </form>
    </AuthLayout>
  );
}
