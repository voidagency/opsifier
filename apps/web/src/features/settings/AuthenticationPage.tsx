import {
  changeCredentialsRequest,
  passwordMaxLength,
  type TwoFactorSetup,
  twoFactorDisable,
} from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../lib/api";
import { errorMessage, schemaErrors, useForm } from "../../lib/forms";
import {
  Button,
  Checkbox,
  CodeInput,
  ConfirmDialog,
  Dialog,
  Field,
  FormBanner,
  Input,
  MonoValue,
  PasswordInput,
  QrCode,
  StatusLamp,
  toast,
  useCopy,
} from "../../ui";
import { applySession, authApi, useCurrentUser } from "../auth/session";

function Section({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-b px-4 py-6 last:border-b-0 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,480px)] lg:px-8">
      <div>
        <h2 className="text-md font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function CredentialsSection({ email }: { email: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const initial = { email, currentPassword: "", newPassword: "" };
  const tooLong = (password: string) =>
    password.length > passwordMaxLength ? t("errors.passwordTooLong", { max: passwordMaxLength }) : undefined;

  const form = useForm({
    t,
    initialValues: initial,
    validate: (values) =>
      schemaErrors(changeCredentialsRequest, values, {
        email: t("errors.email"),
        currentPassword: tooLong(values.currentPassword) ?? t("errors.currentPassword"),
        newPassword: tooLong(values.newPassword) ?? t("errors.newPassword"),
      }),
    onSubmit: async (values) => {
      applySession(queryClient, await authApi.changeCredentials(values));
      form.reset({ email: values.email, currentPassword: "", newPassword: "" });
      toast.success(t("credentials.saved"));
    },
  });

  return (
    <Section title={t("credentials.title")} description={t("credentials.description")}>
      <form onSubmit={form.handleSubmit} noValidate className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("credentials.email")} error={form.errors.email} hint={t("credentials.emailHint")}>
          <Input {...form.field("email")} type="email" autoComplete="username" spellCheck={false} />
        </Field>
        <Field
          label={t("credentials.currentPassword")}
          error={form.errors.currentPassword}
          hint={t("credentials.currentPasswordHint")}
        >
          <PasswordInput {...form.field("currentPassword")} autoComplete="current-password" />
        </Field>
        <Field
          label={t("credentials.newPassword")}
          hint={t("credentials.newPasswordHint")}
          error={form.errors.newPassword}
        >
          <PasswordInput {...form.field("newPassword")} autoComplete="new-password" />
        </Field>
        <div>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("credentials.submit")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function RecoveryCodes({ codes }: { codes: readonly string[] }) {
  const { t } = useTranslation("settings");
  const { copied, copy } = useCopy(codes.join("\n"));

  return (
    <div className="grid gap-3">
      <ul
        aria-label={t("twoFactor.recoveryListLabel")}
        className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-sm bg-wash px-4 py-3 font-mono text-sm"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div>
        <Button onClick={copy}>{copied ? t("common:copy.copied") : t("twoFactor.copyCodes")}</Button>
      </div>
    </div>
  );
}

function TwoFactorSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);

  // Each opening starts over: nothing typed or shown last time should still be there.
  useEffect(() => {
    if (open) {
      setPassword("");
      setPasswordError(null);
      setSetup(null);
      setCode("");
      setCodeError(null);
      setRecoveryCodes(null);
      setSaved(false);
      setBanner(null);
    }
  }, [open]);

  const begin = async () => {
    if (pending) {
      return;
    }
    if (password === "" || password.length > passwordMaxLength) {
      setPasswordError(t("errors.currentPassword"));
      return;
    }
    setPending(true);
    setPasswordError(null);
    setBanner(null);
    try {
      setSetup(await authApi.beginTwoFactor({ currentPassword: password }));
      setPassword("");
    } catch (error) {
      if (error instanceof ApiError && error.fields.currentPassword) {
        setPasswordError(errorMessage(error, t));
      } else {
        setBanner(errorMessage(error, t));
      }
    } finally {
      setPending(false);
    }
  };

  const submit = async (value: string) => {
    if (pending) {
      return;
    }
    if (!/^\d{6}$/.test(value)) {
      setCodeError(t("errors.code"));
      return;
    }
    setPending(true);
    setCodeError(null);
    setBanner(null);
    try {
      const { recoveryCodes: issued, ...session } = await authApi.enableTwoFactor({ code: value });
      applySession(queryClient, session);
      setRecoveryCodes(issued);
      toast.success(t("twoFactor.enabled"));
    } catch (error) {
      setCode("");
      codeInput.current?.focus();
      if (error instanceof ApiError && error.fields.code) {
        setCodeError(errorMessage(error, t));
      } else {
        setBanner(errorMessage(error, t));
      }
    } finally {
      setPending(false);
    }
  };

  // The codes exist nowhere else, so they stay on screen until someone says they have them.
  const handleOpenChange = (next: boolean) => {
    if (next || recoveryCodes === null || saved) {
      onOpenChange(next);
    }
  };

  const step = recoveryCodes !== null ? "codes" : setup !== null ? "scan" : "password";

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      size={step === "scan" ? "lg" : "md"}
      title={step === "codes" ? t("twoFactor.recoveryTitle") : t("twoFactor.dialogTitle")}
      description={t(`twoFactor.stepDescriptions.${step}`)}
      onSubmit={(event) => {
        event.preventDefault();
        if (step === "password") {
          void begin();
        } else if (step === "scan") {
          void submit(code);
        } else if (saved) {
          onOpenChange(false);
        }
      }}
      footer={
        step === "codes" ? (
          <Button
            type="submit"
            variant="primary"
            disabledReason={saved ? undefined : t("twoFactor.recoverySaveFirst")}
          >
            {t("twoFactor.recoveryDone")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" variant="primary" pending={pending}>
              {step === "password" ? t("twoFactor.continue") : t("twoFactor.confirm")}
            </Button>
          </>
        )
      }
    >
      {recoveryCodes !== null ? (
        <div className="grid gap-4">
          <RecoveryCodes codes={recoveryCodes} />
          <Checkbox
            label={t("twoFactor.recoverySaved")}
            checked={saved}
            onChange={(event) => setSaved(event.currentTarget.checked)}
          />
        </div>
      ) : setup === null ? (
        <div className="grid gap-4">
          {banner && <FormBanner>{banner}</FormBanner>}
          <Field
            label={t("twoFactor.currentPassword")}
            error={passwordError}
            hint={t("twoFactor.currentPasswordHint")}
          >
            <PasswordInput
              name="currentPassword"
              value={password}
              onChange={(event) => {
                setPassword(event.currentTarget.value);
                setPasswordError(null);
              }}
              autoComplete="current-password"
              autoFocus
            />
          </Field>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-[auto_minmax(0,1fr)]">
          <div className="grid justify-items-center gap-2 sm:justify-items-start">
            <QrCode value={setup.otpauthUri} label={t("twoFactor.qrLabel")} />
          </div>
          <div className="grid min-w-0 content-start gap-4">
            <ol className="grid gap-1.5 text-sm">
              {(["install", "scan", "enter"] as const).map((step, index) => (
                <li key={step} className="flex gap-2">
                  <span aria-hidden="true" className="font-mono text-xs leading-5 text-muted">
                    {index + 1}
                  </span>
                  <span>{t(`twoFactor.steps.${step}`)}</span>
                </li>
              ))}
            </ol>
            <div>
              <p className="eyebrow">{t("twoFactor.setupKey")}</p>
              <MonoValue
                value={setup.secret}
                copy
                copyLabel={t("twoFactor.copyKey")}
                className="mt-0.5 text-xs break-all"
              />
            </div>
            <Field label={t("twoFactor.codeLabel")} error={codeError} hint={t("twoFactor.codeLabelHint")}>
              <CodeInput
                ref={codeInput}
                name="code"
                value={code}
                onChange={(value) => {
                  setCode(value);
                  setCodeError(null);
                }}
                onComplete={submit}
              />
            </Field>
            {banner && <FormBanner>{banner}</FormBanner>}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function DisableTwoFactorDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPassword("");
      setPasswordError(null);
      setRecoveryMode(false);
      setCode("");
      setRecoveryCode("");
      setCodeError(null);
    }
  }, [open]);

  const clearCodes = () => {
    setCode("");
    setRecoveryCode("");
    setCodeError(null);
  };

  const confirm = async () => {
    const values = {
      currentPassword: password,
      ...(recoveryMode ? { recoveryCode } : { code }),
    };
    const parsed = twoFactorDisable.safeParse(values);
    if (!parsed.success) {
      const codeMessage = t(recoveryMode ? "errors.recoveryCode" : "errors.code");
      const problems = schemaErrors(twoFactorDisable, values, {
        currentPassword: t("errors.currentPassword"),
        code: codeMessage,
        recoveryCode: codeMessage,
      });
      setPasswordError(problems.currentPassword ?? null);
      setCodeError(problems.code ?? problems.recoveryCode ?? null);
      return false;
    }
    try {
      applySession(queryClient, await authApi.disableTwoFactor(parsed.data));
    } catch (error) {
      if (error instanceof ApiError && error.fields.currentPassword) {
        setPassword("");
        setPasswordError(errorMessage(error, t));
        return false;
      }
      if (error instanceof ApiError && (error.fields.code || error.fields.recoveryCode)) {
        clearCodes();
        setCodeError(errorMessage(error, t));
        return false;
      }
      throw error;
    }
    toast.success(t("twoFactor.disabled"));
    return true;
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("twoFactor.disableTitle")}
      description={t("twoFactor.disableDescription")}
      confirmLabel={t("twoFactor.disableConfirm")}
      onConfirm={confirm}
    >
      <Field
        label={t("twoFactor.currentPassword")}
        error={passwordError}
        hint={t("twoFactor.currentPasswordHint")}
      >
        <PasswordInput
          name="currentPassword"
          value={password}
          onChange={(event) => {
            setPassword(event.currentTarget.value);
            setPasswordError(null);
          }}
          autoComplete="current-password"
          autoFocus
        />
      </Field>
      {recoveryMode ? (
        <Field label={t("twoFactor.recoveryCode")} error={codeError} hint={t("twoFactor.recoveryCodeHint")}>
          <Input
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
          />
        </Field>
      ) : (
        <Field label={t("twoFactor.codeLabel")} error={codeError} hint={t("twoFactor.codeLabelHint")}>
          <CodeInput
            name="code"
            value={code}
            onChange={(value) => {
              setCode(value);
              setCodeError(null);
            }}
          />
        </Field>
      )}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            clearCodes();
            setRecoveryMode(!recoveryMode);
          }}
        >
          {recoveryMode ? t("twoFactor.useAuthenticator") : t("twoFactor.useRecoveryCode")}
        </Button>
      </div>
    </ConfirmDialog>
  );
}

function TwoFactorSection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation("settings");
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  return (
    <Section title={t("twoFactor.title")} description={t("twoFactor.description")}>
      <div className="grid gap-4">
        <div className="flex items-center gap-2.5">
          <StatusLamp
            status={enabled ? "ok" : "off"}
            label={enabled ? t("twoFactor.on") : t("twoFactor.off")}
            showLabel
          />
        </div>
        {!enabled && <FormBanner tone="warning">{t("twoFactor.warning")}</FormBanner>}
        <div>
          {enabled ? (
            <Button variant="secondary" onClick={() => setDisableOpen(true)}>
              {t("twoFactor.disable")}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setSetupOpen(true)}>
              {t("twoFactor.setUp")}
            </Button>
          )}
        </div>
      </div>
      <TwoFactorSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
      <DisableTwoFactorDialog open={disableOpen} onOpenChange={setDisableOpen} />
    </Section>
  );
}

export function AuthenticationPage() {
  const user = useCurrentUser();
  if (!user) {
    return null;
  }
  return (
    <>
      <CredentialsSection email={user.email} />
      <TwoFactorSection enabled={user.twoFactorEnabled} />
    </>
  );
}
