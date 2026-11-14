import { type SystemAbout, systemAbout } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/forms";
import { ErrorState, Skeleton, Table, TBody, TD, TH, THead, TR } from "../../ui";

export const systemAboutQuery = {
  queryKey: ["system", "about"] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => api.get("/system/about", { schema: systemAbout, signal }),
  // What the image ships only changes with the panel's version.
  staleTime: Number.POSITIVE_INFINITY,
};

const linkClass = "underline underline-offset-2 hover:text-ink";

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={linkClass}>
      {children}
    </a>
  );
}

function Components({ list }: { list: SystemAbout["components"] }) {
  const { t } = useTranslation("settings-about");
  return (
    <Table>
      <THead>
        <TR>
          <TH>{t("components.name")}</TH>
          <TH>{t("components.version")}</TH>
          <TH>{t("components.license")}</TH>
        </TR>
      </THead>
      <TBody>
        {list.map((component) => (
          <TR key={`${component.name}@${component.version ?? ""}`}>
            <TD>
              {component.url === null ? (
                component.name
              ) : (
                <External href={component.url}>{component.name}</External>
              )}
            </TD>
            <TD mono>{component.version ?? t("components.fromRepository")}</TD>
            <TD mono>{component.license}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/**
 * Opsifier's license and where its code is, and what the panel's image holds from others, each
 * with its own license: what the image owes them, said where everyone using the panel can see it.
 */
export function AboutPage() {
  const { t } = useTranslation(["settings-about", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery(systemAboutQuery);

  if (isPending) {
    return <Skeleton className="m-6 h-40" />;
  }
  if (isError) {
    return <ErrorState className="m-6" message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }

  const programs = data.components.filter((component) => component.kind === "program");
  const packages = data.components.filter((component) => component.kind === "package");

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 md:px-6 lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 font-mono text-sm text-muted">{t("version", { version: data.version })}</p>
      </div>

      <section className="grid max-w-[850px] gap-3 border-t pt-5">
        <h3 className="font-medium">{t("license.title")}</h3>
        <p className="max-w-[70ch] text-sm">{t("license.body")}</p>
        <p className="text-sm text-muted">{data.copyright}</p>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <li>
            <External href={data.licenseUrl}>{t("license.read")}</External>
          </li>
          <li>
            <External href={data.sourceUrl}>{t("license.source")}</External>
          </li>
          <li>
            <External href={`${data.sourceUrl}/releases/tag/v${data.version}`}>
              {t("license.release")}
            </External>
          </li>
        </ul>
      </section>

      <section className="grid max-w-[850px] gap-3 border-t pt-5">
        <h3 className="font-medium">{t("components.title")}</h3>
        {data.noticesFile === null ? (
          <p className="max-w-[70ch] text-sm text-muted">{t("components.none")}</p>
        ) : (
          <>
            <p className="max-w-[70ch] text-sm">{t("components.intro")}</p>
            <p className="text-sm text-muted">
              {t("components.file")} <code className="font-mono text-xs">{data.noticesFile}</code>
            </p>
            <h4 className="mt-2 text-sm font-medium">
              {t("components.programs", { count: programs.length })}
            </h4>
            <Components list={programs} />
            <details className="mt-2">
              <summary className="cursor-pointer text-sm font-medium">
                {t("components.packages", { count: packages.length })}
              </summary>
              <div className="mt-3">
                <Components list={packages} />
              </div>
            </details>
          </>
        )}
      </section>
    </div>
  );
}
