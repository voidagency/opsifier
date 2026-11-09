import type { ReleaseEntry, ReleaseRefusal } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { History } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, formatDateTime, formatRelativeTime } from "../../../../lib/format";
import { errorMessage } from "../../../../lib/forms";
import {
  Button,
  ErrorState,
  GaugeBar,
  Lamp,
  MonoValue,
  SectionIntro,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
  type VisualState,
} from "../../../../ui";
import { useCurrentUser } from "../../../auth/session";
import { releasesQuery } from "../../api";
import { RollbackDialog } from "./RollbackDialog";

/** Short enough to scan down a column. The full value is one tooltip away. */
const shortId = (value: string) => value.replace(/^sha256:/, "").slice(0, 12);

function stateOf(release: ReleaseEntry): VisualState {
  if (release.active) {
    return "running";
  }
  return release.refusal === null ? "stopped" : "degraded";
}

function StateCell({ release }: { release: ReleaseEntry }) {
  const { t } = useTranslation("service-deployments");
  const refusal: ReleaseRefusal | null = release.active ? null : release.refusal;
  const label = release.active
    ? t("versions.active")
    : refusal === null
      ? t("versions.kept")
      : t(`versions.refusal.${refusal}.label`);
  return <Lamp state={stateOf(release)} label={label} showLabel />;
}

function CommitCell({ release }: { release: ReleaseEntry }) {
  const { t } = useTranslation("service-deployments");
  if (release.builtCommit === null) {
    return <span className="text-muted">{t("versions.noCommit")}</span>;
  }
  const details = [
    release.requestedRef === null ? null : t("versions.requested", { ref: release.requestedRef }),
    t("versions.built", { commit: release.builtCommit }),
    release.ociRevision === null ? null : t("versions.ociRevision", { revision: release.ociRevision }),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <Tooltip content={details}>
      <button type="button" className="font-mono text-xs underline decoration-dotted underline-offset-2">
        {shortId(release.builtCommit)}
      </button>
    </Tooltip>
  );
}

function RollbackButton({
  release,
  busy,
  onChoose,
}: {
  release: ReleaseEntry;
  busy: boolean;
  onChoose: (release: ReleaseEntry) => void;
}) {
  const { t } = useTranslation("service-deployments");
  if (release.active) {
    return null;
  }
  const blocked = release.refusal !== null || busy;
  const reason =
    release.refusal !== null
      ? t(`versions.refusal.${release.refusal}.reason`, { number: release.number })
      : busy
        ? t("versions.busy")
        : t("versions.goBackHint", { number: release.number });
  return (
    <Tooltip content={reason}>
      <span className="inline-flex">
        <Button
          size="sm"
          icon={<History aria-hidden="true" className="size-4" />}
          disabled={blocked}
          onClick={() => onChoose(release)}
        >
          {t("versions.goBack")}
        </Button>
      </span>
    </Tooltip>
  );
}

/**
 * The versions this service keeps, the running one marked, each with what it would take to go back
 * to it. Only for what has versions: Compose stacks and databases show nothing here.
 */
export function VersionsPanel({
  project,
  service,
  busy,
}: {
  project: string;
  service: string;
  busy: boolean;
}) {
  const { t, i18n } = useTranslation(["service-deployments", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery(releasesQuery(project, service));
  const [chosen, setChosen] = useState<ReleaseEntry | null>(null);
  const user = useCurrentUser();

  if (isPending) {
    return <Skeleton className="h-24" />;
  }
  if (isError) {
    return (
      <section className="grid gap-3">
        <SectionIntro pictogram="restore" title={t("versions.title")} />
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      </section>
    );
  }
  if (!data.available || data.items.length === 0) {
    return null;
  }

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <SectionIntro
          pictogram="restore"
          title={t("versions.title")}
          description={t("versions.description")}
        />
        <div className="flex min-w-56 items-center gap-3">
          <GaugeBar
            value={data.items.length}
            max={data.keep}
            label={t("versions.keptGauge", { count: data.items.length, keep: data.keep })}
            display={t("versions.keptShort", { count: data.items.length, keep: data.keep })}
            thresholds={{ busy: 2, bad: 2 }}
          />
          {user?.role === "admin" ? (
            <Link
              to="/settings/server/general"
              className="whitespace-nowrap text-sm text-muted underline underline-offset-4 hover:text-ink"
            >
              {t("versions.changeKept")}
            </Link>
          ) : (
            <Tooltip content={t("versions.changeKeptHint", { keep: data.keep })}>
              <button
                type="button"
                className="whitespace-nowrap text-sm text-muted underline decoration-dotted underline-offset-2"
              >
                {t("versions.howMany", { keep: data.keep })}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      <Table>
        <THead>
          <TR>
            <TH>{t("versions.state")}</TH>
            <TH>{t("versions.version")}</TH>
            <TH>{t("versions.image")}</TH>
            <TH>{t("versions.commit")}</TH>
            <TH>{t("versions.deployed")}</TH>
            <TH className="text-right">{t("versions.size")}</TH>
            <TH className="text-right">
              <span className="sr-only">{t("versions.action")}</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {data.items.map((release) => (
            <TR key={release.number}>
              <TD>
                <StateCell release={release} />
              </TD>
              <TD>
                <span className="flex flex-wrap items-center gap-x-2">
                  <MonoValue value={`#${release.number}`} />
                  {release.rollbackOf !== null && (
                    <span className="text-sm text-muted">
                      {t("versions.backTo", { number: release.rollbackOf })}
                    </span>
                  )}
                </span>
              </TD>
              <TD>
                <Tooltip content={release.digest ?? release.imageId}>
                  <button type="button" className="max-w-56 truncate text-left font-mono text-xs">
                    {release.image}
                  </button>
                </Tooltip>
              </TD>
              <TD>
                <CommitCell release={release} />
              </TD>
              <TD>
                <Tooltip content={formatDateTime(release.createdAt, i18n.language)}>
                  <button type="button">{formatRelativeTime(release.createdAt, i18n.language)}</button>
                </Tooltip>
              </TD>
              <TD className="text-right" mono>
                {formatBytes(release.sizeBytes)}
              </TD>
              <TD className="text-right">
                <RollbackButton release={release} busy={busy} onChoose={setChosen} />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <RollbackDialog project={project} service={service} release={chosen} onClose={() => setChosen(null)} />
    </section>
  );
}
