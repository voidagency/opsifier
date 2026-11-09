import type { ServerPurposeState } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Lamp, Pictogram, Tooltip } from "../../ui";
import { purposeQuery } from "./api";
import { FirstUsePrompt } from "./FirstUsePrompt";
import { purposeLook, stateFromProtection } from "./purpose";

const hasGap = (state: ServerPurposeState) =>
  state.protection && (state.protectedCount < state.totalCount || state.problems.length > 0);

function Count({ state }: { state: ServerPurposeState }) {
  const { t } = useTranslation("server-purpose");
  if (!state.protection) {
    return (
      <>
        <Lamp state="stopped" size="xs" decorative />
        <span className="font-mono tabular-nums">
          {t("indicator.publicCount", { count: state.totalCount })}
        </span>
      </>
    );
  }
  const failed = hasGap(state);
  return (
    <>
      <Lamp state={failed ? "failed" : "running"} size="xs" decorative still />
      <span className="font-mono tabular-nums">
        {state.protectedCount}/{state.totalCount}
      </span>
    </>
  );
}

function Purpose({ state }: { state: ServerPurposeState }) {
  const { t } = useTranslation("server-purpose");
  if (state.purpose === null) {
    return (
      <>
        <Lamp state="unknown" size="xs" decorative />
        <span className="hidden font-medium sm:inline xl:hidden min-[90rem]:inline">
          {t("purposes.unset")}
        </span>
      </>
    );
  }
  const look = purposeLook[state.purpose];
  return (
    <>
      <span style={{ color: look.color }} className="flex">
        <Pictogram name={look.pictogram} size={16} />
      </span>
      <span className="hidden font-medium sm:inline xl:hidden min-[90rem]:inline">
        {t(`purposes.${state.purpose}`)}
      </span>
    </>
  );
}

function summary(state: ServerPurposeState, t: ReturnType<typeof useTranslation>["t"]): string {
  const purpose = state.purpose === null ? t("purposes.unset") : t(`purposes.${state.purpose}`);
  if (!state.protection) {
    return t("indicator.summaryPublic", { purpose, count: state.totalCount });
  }
  if (state.problems.some((problem) => problem.code === "no_credentials")) {
    return t("indicator.summaryLocked", { purpose });
  }
  if (hasGap(state)) {
    return t("indicator.summaryGap", { purpose, protected: state.protectedCount, total: state.totalCount });
  }
  return t("indicator.summaryProtected", {
    purpose,
    protected: state.protectedCount,
    total: state.totalCount,
  });
}

const chip = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-sm text-ink hover:bg-wash";

/** Purpose and protection, on every page. A gap in protection comes first, because it is a failure. */
export function ServerPurposeIndicator() {
  const { t } = useTranslation("server-purpose");
  const { data, isError } = useQuery(purposeQuery);

  if (data === undefined) {
    return isError ? (
      <span className={chip} title={t("indicator.unknown")}>
        <Lamp state="unknown" size="xs" label={t("indicator.unknown")} />
      </span>
    ) : (
      <span aria-hidden="true" className="h-8 w-16 shrink-0" />
    );
  }

  const failed = hasGap(data);
  const label = summary(data, t);
  return (
    <>
      <Tooltip content={label}>
        <Link to="/settings/server/purpose" className={chip}>
          {failed && <Count state={data} />}
          <Purpose state={data} />
          {!failed && (
            <span className="hidden items-center gap-1.5 sm:inline-flex">
              <Count state={data} />
            </span>
          )}
          <span className="sr-only">{label}</span>
        </Link>
      </Tooltip>
      <FirstUsePrompt state={data} />
    </>
  );
}

/** The lamp on a domain's row. It reads the same report as the top bar, so the two always agree. */
export function DomainProtectionLamp({
  host,
  path = "/",
  wildcard = false,
}: {
  host: string;
  path?: string;
  wildcard?: boolean;
}) {
  const { t } = useTranslation("server-purpose");
  const { data } = useQuery(purposeQuery);

  if (data === undefined) {
    return <Lamp state="unknown" size="xs" label={t("lamp.unknown")} />;
  }
  const domain = data.domains.find(
    (candidate) => candidate.host === host && candidate.path === path && candidate.wildcard === wildcard,
  );
  // The report comes from what the proxy holds: a route it does not know about has no protection to show.
  const status = domain?.status ?? (data.protection ? "exposed" : "public");
  return <Lamp state={stateFromProtection(status)} size="xs" still label={t(`lamp.${status}`)} />;
}
