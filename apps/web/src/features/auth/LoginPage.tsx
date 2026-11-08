import {
  loginRequest,
  passwordMaxLength,
  recoveryCode as recoveryCodeRule,
  type SessionState,
  twoFactorRequiredCode,
} from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearch } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../lib/api";
import { errorMessage, schemaErrors, useForm } from "../../lib/forms";
import { Button, Checkbox, CodeInput, Field, FormBanner, Input, PasswordInput } from "../../ui";
import { AuthLayout } from "./AuthLayout";
import { applySession, authApi } from "./session";

export function LoginPage() {
  const { t } = useTranslation("auth");
  const queryClient = useQueryClient();
  const router = useRouter();
  const search = useSearch({ from: "/login" });
  const [codeStep, setCodeStep] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeBanner, setCodeBanner] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const recoveryInput = useRef<HTMLInputElement>(null);

  const finish = async (session: SessionState) => {
    applySession(queryClient, session);
    await router.navigate({ href: search.redirect ?? "/", replace: true });
  };

  const form = useForm({
    t,
    initialValues: { email: "", password: "", rememberMe: false },
    validate: (values) =>
      schemaErrors(loginRequest, values, {
        email: t("errors.email"),
        password:
          values.password.length > passwordMaxLength
            ? t("errors.passwordTooLong", { max: passwordMaxLength })
            : t("errors.passwordRequired"),
      }),
    onSubmit: async (values) => {
      let session: SessionState;
      try {
        session = await authApi.login(values);
      } catch (error) {
        if (error instanceof ApiError && error.code === twoFactorRequiredCode) {
          setCodeStep(true);
          return;
        }
        throw error;
      }
      await finish(session);
    },
  });

  const verify = async (secondFactor: { code: string } | { recoveryCode: string }) => {
    setVerifying(true);
    setCodeError(null);
    setCodeBanner(null);
    try {
      await finish(await authApi.login({ ...form.values, ...secondFactor }));
    } catch (error) {
      setCode("");
      setRecoveryCode("");
      (recoveryMode ? recoveryInput : codeInput).current?.focus();
      if (error instanceof ApiError && (error.fields.code || error.fields.recoveryCode)) {
        setCodeError(errorMessage(error, t));
      } else {
        setCodeBanner(errorMessage(error, t));
      }
    } finally {
      setVerifying(false);
    }
  };

  const submitCode = async (value: string) => {
    if (verifying) {
      return;
    }
    if (!/^\d{6}$/.test(value)) {
      setCodeError(t("errors.code"));
      return;
    }
    await verify({ code: value });
  };

  const submitRecoveryCode = async () => {
    if (verifying) {
      return;
    }
    if (!recoveryCodeRule.safeParse(recoveryCode).success) {
      setCodeError(t("errors.recoveryCode"));
      return;
    }
    await verify({ recoveryCode });
  };

  const clearCodeStep = () => {
    setCode("");
    setRecoveryCode("");
    setCodeError(null);
    setCodeBanner(null);
  };

  if (codeStep) {
    return (
      <AuthLayout
        title={recoveryMode ? t("twoFactor.recoveryTitle") : t("twoFactor.title")}
        description={recoveryMode ? t("twoFactor.recoveryDescription") : t("twoFactor.description")}
      >
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void (recoveryMode ? submitRecoveryCode() : submitCode(code));
          }}
          className="grid gap-5"
        >
          {codeBanner && <FormBanner>{codeBanner}</FormBanner>}
          {recoveryMode ? (
            <Field label={t("twoFactor.recoveryCode")} error={codeError}>
              <Input
                ref={recoveryInput}
                name="recoveryCode"
                mono
                value={recoveryCode}
                onChange={(event) => {
                  setRecoveryCode(event.currentTarget.value);
                  setCodeError(null);
                }}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
              />
            </Field>
          ) : (
            <Field label={t("twoFactor.code")} error={codeError}>
              <CodeInput
                ref={codeInput}
                name="code"
                value={code}
                onChange={(value) => {
                  setCode(value);
                  setCodeError(null);
                }}
                onComplete={submitCode}
                autoFocus
              />
            </Field>
          )}
          <div className="grid gap-2">
            <Button type="submit" variant="primary" size="lg" pending={verifying} className="w-full">
              {t("twoFactor.submit")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                clearCodeStep();
                setRecoveryMode(!recoveryMode);
              }}
            >
              {recoveryMode ? t("twoFactor.useAuthenticator") : t("twoFactor.useRecoveryCode")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setCodeStep(false);
                setRecoveryMode(false);
                clearCodeStep();
              }}
            >
              {t("twoFactor.back")}
            </Button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("login.title")} description={t("login.description")}>
      <form onSubmit={form.handleSubmit} noValidate className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("fields.email")} error={form.errors.email}>
          <Input {...form.field("email")} type="email" autoComplete="username" autoFocus spellCheck={false} />
        </Field>
        <Field label={t("fields.password")} error={form.errors.password}>
          <PasswordInput {...form.field("password")} autoComplete="current-password" />
        </Field>
        <Checkbox
          label={t("login.remember")}
          checked={form.values.rememberMe}
          onChange={(event) => form.set("rememberMe", event.currentTarget.checked)}
        />
        <Button type="submit" variant="primary" size="lg" pending={form.pending} className="mt-2 w-full">
          {t("login.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
