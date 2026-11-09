import type { DeploymentEntry } from "@opsifier/contract";
import { rollbackActionType } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, User } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration, formatRelativeTime } from "../../../../lib/format";
import { errorMessage } from "../../../../lib/forms";
import {
  Button,
  EmptyState,
  ErrorState,
  Lamp,
  Skeleton,
  stateFromAction,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
} from "../../../../ui";
import { ActionLogDialog } from "../../../activity/ActionLogDialog";
import { deploymentsQuery, isActive, serviceQuery, useServiceParams } from "../../api";
import { PendingChangesPanel } from "./PendingChanges";
import { TriggerCard } from "./TriggerCard";
import { VersionsPanel } from "./VersionsPanel";

/** Who started a deployment and how: a person, a key, a CI trigger, a webhook or the panel itself. */
function StartedBy({ action }: { action: DeploymentEntry }) {
  const { t } = useTranslation("service-deployments");
  const label = action.origin === "system" ? t("byPanel") : t(`origin.${action.origin}`);
  const details = [action.originDetail, action.actorEmail].filter((part) => part !== null).join(" · ");
  if (action.origin === "session" && action.actorEmail !== null) {
    return (
      <Tooltip content={action.actorEmail}>
        <button
          type="button"
          aria-label={action.actorEmail}
          className="flex size-7 items-center justify-center rounded-sm text-muted"
        >
          <User aria-hidden="true" className="size-3.5" />
        </button>
      </Tooltip>
    );
  }
  return details === "" ? (
    <span className="text-muted">{label}</span>
  ) : (
    <Tooltip content={details}>
      <button type="button" className="text-left text-muted underline decoration-dotted underline-offset-2">
        {label}
      </button>
    </Tooltip>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The image it ran and the commit it came from, for a row of the history. */
function WhatRan({ action }: { action: DeploymentEntry }) {
  const { t } = useTranslation("service-deployments");
  const record = action.deployment;
  if (record === null || record.image === null) {
    return <span className="text-muted">{t("history.unknownImage")}</span>;
  }
  const details = [
    record.digest ?? record.imageId,
    record.requestedRef === null ? null : t("versions.requested", { ref: record.requestedRef }),
    record.builtCommit === null ? null : t("versions.built", { commit: record.builtCommit }),
    record.ociRevision === null ? null : t("versions.ociRevision", { revision: record.ociRevision }),
    record.answering === null ? null : record.answering ? t("history.answering") : t("history.silent"),
    record.runningTasks === null
      ? null
      : t("history.tasks", { running: record.runningTasks, desired: record.desiredTasks }),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <Tooltip content={details}>
      <button type="button" className="max-w-48 truncate text-left font-mono text-xs">
        {record.builtCommit === null ? record.image : record.builtCommit.slice(0, 12)}
      </button>
    </Tooltip>
  );
}

/** A rollback is an attempt like any other, and says where it went. */
function Lineage({ action }: { action: DeploymentEntry }) {
  const { t } = useTranslation("service-deployments");
  if (action.type !== rollbackActionType) {
    return null;
  }
  const target = action.deployment?.rollbackOf;
  return (
    <span className="ml-2 text-sm text-muted">
      {target === null || target === undefined
        ? t("history.rollback")
        : t("versions.backTo", { number: target })}
    </span>
  );
}

/** Every deployment of the service. A row stays live until its Action has finished. */
export function DeploymentsTab() {
  const { t, i18n } = useTranslation(["service-deployments", "common"]);
  const { project, service } = useServiceParams();
  const { data, isPending, isError, error, refetch } = useQuery(deploymentsQuery(project, service));
  const { data: detail } = useQuery(serviceQuery(project, service));
  const [viewingId, setViewingId] = useState<string | null>(null);
  const items = data?.items ?? [];
  const viewing = items.find((action) => action.id === viewingId) ?? null;
  const now = useNow(items.some(isActive));

  if (isPending) {
    return (
      <div className="grid max-w-[1100px] gap-3 px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-6" />
        <Skeleton className="h-6" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="grid gap-8 px-4 py-6 md:px-6 lg:px-8">
      {detail?.pendingChanges === true && <PendingChangesPanel project={project} service={service} />}
      <VersionsPanel project={project} service={service} busy={detail?.activeAction !== null} />
      {items.length === 0 ? (
        <EmptyState
          illustration="no-deployments"
          title={t("empty.title")}
          description={t("empty.description")}
        />
      ) : (
        <div className="max-w-[1100px]">
          <Table>
            <THead>
              <TR>
                <TH>{t("columns.outcome")}</TH>
                <TH>{t("columns.ran")}</TH>
                <TH>{t("columns.started")}</TH>
                <TH>{t("columns.duration")}</TH>
                <TH>{t("columns.by")}</TH>
                <TH className="text-right">{t("columns.log")}</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((action) => (
                <TR key={action.id}>
                  <TD>
                    <Lamp
                      state={stateFromAction(action.status)}
                      label={t(`status.${action.status}`)}
                      showLabel
                    />
                    <Lineage action={action} />
                  </TD>
                  <TD>
                    <WhatRan action={action} />
                  </TD>
                  <TD>{formatRelativeTime(action.createdAt, i18n.language, now)}</TD>
                  <TD mono>
                    {action.startedAt === null
                      ? "--"
                      : formatDuration(action.startedAt, action.finishedAt, now)}
                  </TD>
                  <TD>
                    <StartedBy action={action} />
                  </TD>
                  <TD className="text-right">
                    <Button
                      size="icon-sm"
                      aria-label={t("view")}
                      tooltip={t("view")}
                      disabledReason={action.hasLog ? undefined : t("noLog")}
                      onClick={() => setViewingId(action.id)}
                    >
                      <ScrollText aria-hidden="true" className="size-3.5" />
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
      <TriggerCard />
      <ActionLogDialog action={viewing} onClose={() => setViewingId(null)} />
    </div>
  );
}
