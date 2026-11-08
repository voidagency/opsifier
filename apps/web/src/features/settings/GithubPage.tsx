import { saveGithubTokenRequest } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { errorMessage, useForm } from "../../lib/forms";
import { Button, Field, FormBanner, PasswordInput, Skeleton, toast } from "../../ui";
import { githubStatusQuery } from "../services/tabs/source/api";

const TOKEN_PAGE = "https://github.com/settings/tokens/new?scopes=repo,admin:repo_hook&description=Opsifier";

/** The token that opens private repositories and adds webhooks. It is checked before being stored. */
export function GithubPage() {
  const { t } = useTranslation(["github", "common"]);
  const queryClient = useQueryClient();
  const { data: status, isPending, isError, error, refetch } = useQuery(githubStatusQuery);

  const form = useForm({
    t,
    initialValues: { token: "" },
    validate: ({ token }) =>
      saveGithubTokenRequest.safeParse({ token }).success ? {} : { token: t("errors.tokenRequired") },
    onSubmit: async ({ token }) => {
      await api.put("/settings/github", { body: { token } });
      await queryClient.invalidateQueries({ queryKey: ["github"] });
      form.reset({ token: "" });
      toast.success(t("saved"));
    },
  });

  const remove = async () => {
    try {
      await api.delete("/settings/github");
      await queryClient.invalidateQueries({ queryKey: ["github"] });
      toast.success(t("removed"));
    } catch (failure) {
      form.setBanner(errorMessage(failure, t));
    }
  };

  return (
    <section className="grid gap-x-10 gap-y-4 px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,520px)] lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("description")}</p>
      </div>
      {isPending ? (
        <Skeleton className="h-32" />
      ) : isError ? (
        <div className="grid justify-items-start gap-3">
          <FormBanner>{errorMessage(error, t)}</FormBanner>
          <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
        </div>
      ) : (
        <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[520px] gap-4">
          {form.banner && <FormBanner>{form.banner}</FormBanner>}
          {status.configured && (
            <FormBanner tone="success">{t("connected", { login: status.login })}</FormBanner>
          )}
          <Field
            label={t("token")}
            hint={
              <>
                {t("tokenHint")}{" "}
                <a
                  href={TOKEN_PAGE}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  {t("create")}
                </a>
              </>
            }
            error={form.errors.token}
          >
            <PasswordInput
              {...form.field("token")}
              autoComplete="off"
              placeholder={status.configured ? t("placeholder") : undefined}
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" pending={form.pending}>
              {t("save")}
            </Button>
            {status.configured && <Button onClick={remove}>{t("remove")}</Button>}
          </div>
        </form>
      )}
    </section>
  );
}
