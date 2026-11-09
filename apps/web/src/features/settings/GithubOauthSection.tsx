import { type GithubStatus, githubOauthCallbackPath, saveGithubOauthAppRequest } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { errorMessage, useForm } from "../../lib/forms";
import { Button, CopyButton, Field, FormBanner, Input, PasswordInput, toast } from "../../ui";

const REGISTER_PAGE = "https://github.com/settings/applications/new";

/** Connecting through an OAuth app the owner registers, instead of pasting a token. */
export function GithubOauthSection({ status }: { status: GithubStatus }) {
  const { t } = useTranslation(["github", "common"]);
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as { connected?: string; oauthError?: string };
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const callback = `${window.location.origin}${githubOauthCallbackPath}`;
  const reported = useRef(false);

  // GitHub sends the browser back here with the outcome in the address, which is only said once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each outcome is reported once
  useEffect(() => {
    if (reported.current) {
      return;
    }
    reported.current = search.connected !== undefined || search.oauthError !== undefined;
    if (search.connected !== undefined) {
      toast.success(t("oauth.connected"));
      void queryClient.invalidateQueries({ queryKey: ["github"] });
    }
    if (search.oauthError !== undefined) {
      toast.error(
        t("oauth.failed"),
        t(`oauth.errors.${search.oauthError}`, { defaultValue: "" }) || undefined,
      );
    }
  }, [search.connected, search.oauthError]);

  const form = useForm({
    t,
    initialValues: { clientId: "", clientSecret: "" },
    validate: (values) => {
      const parsed = saveGithubOauthAppRequest.safeParse(values);
      if (parsed.success) {
        return {};
      }
      const fields = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
      return {
        ...(fields.has("clientId") ? { clientId: t("errors.clientIdRequired") } : {}),
        ...(fields.has("clientSecret") ? { clientSecret: t("errors.clientSecretRequired") } : {}),
      };
    },
    onSubmit: async (values) => {
      await api.put("/settings/github/oauth", { body: values });
      await queryClient.invalidateQueries({ queryKey: ["github"] });
      form.reset({ clientId: "", clientSecret: "" });
      toast.success(t("oauth.saved"));
    },
  });

  const connect = async () => {
    try {
      setBusy(true);
      setFailure(null);
      const { authorizationUrl } = await api.post<{ authorizationUrl: string }>(
        "/settings/github/oauth/start",
      );
      window.location.assign(authorizationUrl);
    } catch (error) {
      setBusy(false);
      setFailure(errorMessage(error, t));
    }
  };

  const removeApp = async () => {
    try {
      setFailure(null);
      await api.delete("/settings/github/oauth");
      await queryClient.invalidateQueries({ queryKey: ["github"] });
      toast.success(t("oauth.removed"));
    } catch (error) {
      setFailure(errorMessage(error, t));
    }
  };

  return (
    <section className="grid gap-x-10 gap-y-4 border-t px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,520px)] lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("oauth.title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("oauth.description")}</p>
      </div>
      <div className="grid max-w-[650px] gap-4">
        {failure && <FormBanner>{failure}</FormBanner>}
        <Field label={t("oauth.callback")} hint={t("oauth.callbackHint")}>
          <div className="flex items-center gap-2">
            <Input mono readOnly value={callback} className="min-w-0 flex-1" />
            <CopyButton value={callback} label={t("oauth.copyCallback")} />
          </div>
        </Field>
        {status.oauthApp !== null ? (
          <div className="grid gap-3">
            <p className="text-sm">
              {t("oauth.app")} <span className="font-mono">{status.oauthApp.clientId}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" pending={busy} onClick={connect}>
                {t("oauth.connect")}
              </Button>
              <Button onClick={removeApp}>{t("oauth.removeApp")}</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={form.handleSubmit} noValidate className="grid gap-4">
            {form.banner && <FormBanner>{form.banner}</FormBanner>}
            <Field
              label={t("oauth.clientId")}
              hint={
                <a
                  href={REGISTER_PAGE}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  {t("oauth.register")}
                </a>
              }
              error={form.errors.clientId}
            >
              <Input mono autoComplete="off" {...form.field("clientId")} />
            </Field>
            <Field
              label={t("oauth.clientSecret")}
              hint={t("oauth.clientSecretHint")}
              error={form.errors.clientSecret}
            >
              <PasswordInput autoComplete="off" {...form.field("clientSecret")} />
            </Field>
            <div>
              <Button type="submit" variant="primary" pending={form.pending}>
                {t("oauth.saveApp")}
              </Button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
