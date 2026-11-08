import type { ActionEntry } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, User } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration, formatRelativeTime } from "../../../../lib/format";
import { errorMessage } from "../../../../lib/forms";
import {
  Button,
  EmptyState,
  FormBanner,
  Skeleton,
  StatusLamp,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
} from "../../../../ui";
import { ActionLogDialog } from "../../../activity/ActionLogDialog";
import { lampForAction } from "../../../activity/labels";
import { deploymentsQuery, isActive, useServiceParams } from "../../api";
import { TriggerCard } from "./TriggerCard";

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

/** Every deployment of the service. A row stays live until its Action has finished. */
export function DeploymentsTab() {
  const { t, i18n } = useTranslation(["service-deployments", "common"]);
  const { project, service } = useServiceParams();
  const { data, isPending, isError, error, refetch } = useQuery(deploymentsQuery(project, service));
  const [viewing, setViewing] = useState<ActionEntry | null>(null);
  const items = data?.items ?? [];
  const now = useNow(items.some(isActive));

  if (isPending) {
    return (
      <div className="grid max-w-[880px] gap-3 px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-6" />
        <Skeleton className="h-6" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid max-w-[520px] justify-items-start gap-3 px-4 py-6 md:px-6 lg:px-8">
        <FormBanner>{errorMessage(error, t)}</FormBanner>
        <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
      </div>
    );
  }

  return (
    <div className="px-4 py-6 md:px-6 lg:px-8">
      {items.length === 0 ? (
        <EmptyState title={t("empty.title")} description={t("empty.description")} />
      ) : (
        <div className="max-w-[880px]">
          <Table>
            <THead>
              <TR>
                <TH>{t("columns.outcome")}</TH>
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
                    <StatusLamp
                      status={lampForAction(action.status)}
                      label={t(`status.${action.status}`)}
                      showLabel
                    />
                  </TD>
                  <TD>{formatRelativeTime(action.createdAt, i18n.language, now)}</TD>
                  <TD mono>
                    {action.startedAt === null
                      ? "--"
                      : formatDuration(action.startedAt, action.finishedAt, now)}
                  </TD>
                  <TD>
                    {action.actorEmail === null ? (
                      <span className="text-muted">{t("byPanel")}</span>
                    ) : (
                      <Tooltip content={action.actorEmail}>
                        <button
                          type="button"
                          aria-label={action.actorEmail}
                          className="flex size-7 items-center justify-center rounded-sm text-muted"
                        >
                          <User aria-hidden="true" className="size-3.5" />
                        </button>
                      </Tooltip>
                    )}
                  </TD>
                  <TD className="text-right">
                    <Button
                      size="sm"
                      icon={<ScrollText aria-hidden="true" className="size-3.5" />}
                      disabled={!action.hasLog}
                      onClick={() => setViewing(action)}
                    >
                      {t("view")}
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
      <div className="mt-8">
        <TriggerCard />
      </div>
      <ActionLogDialog action={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
