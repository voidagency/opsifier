import type { DomainTlsState, OverviewDomain } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  ConfirmDialog,
  countStates,
  EmptyState,
  ErrorState,
  HealthSummary,
  Lamp,
  MonoValue,
  PageHeader,
  Pictogram,
  Skeleton,
  Tooltip,
  toast,
  type VisualState,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { DomainProtectionLamp } from "../server-purpose/ProtectionIndicator";
import { domainsOverviewKey, domainsOverviewQuery, overviewApi } from "./api";
import { DomainFormDialog } from "./DomainFormDialog";

const tlsStates: Record<DomainTlsState, VisualState> = {
  issued: "running",
  expiring: "degraded",
  expired: "failed",
  pending: "progress",
  none: "stopped",
  unreadable: "failed",
  unverified: "unknown",
};

function DomainRow({
  domain,
  canChange,
  onEdit,
  onDelete,
}: {
  domain: OverviewDomain;
  canChange: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("domains");
  const stateLabel = t(`tls.${domain.tls}`);
  const target =
    domain.destination === "service"
      ? `${domain.projectName}/${domain.serviceName} → ${domain.internalUrl}`
      : domain.servers.map((server) => server.url).join(", ");
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b py-2.5 last:border-b-0">
      <span className="inline-flex items-center gap-1.5 text-muted" title={stateLabel}>
        <Pictogram name="certificate" size={16} />
        <Lamp state={tlsStates[domain.tls]} label={stateLabel} />
        <DomainProtectionLamp host={domain.host} path={domain.path} wildcard={domain.wildcard} />
      </span>
      <div className="min-w-0">
        <MonoValue value={domain.url} className="block truncate text-sm" />
        <p className="truncate font-mono text-xs text-muted" title={target}>
          {target}
        </p>
      </div>
      <div className="flex items-center gap-0.5">
        <Tooltip content={t("open")}>
          <a
            href={domain.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={t("open")}
            className="flex size-8 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
          >
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
        </Tooltip>
        {canChange && (
          <>
            <Tooltip content={t("edit")}>
              <Button size="icon" variant="ghost" aria-label={t("edit")} onClick={onEdit}>
                <Pencil aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content={t("remove")}>
              <Button size="icon" variant="ghost" aria-label={t("remove")} onClick={onDelete}>
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
          </>
        )}
      </div>
    </li>
  );
}

const hostLabel = (domain: OverviewDomain) => domain.url.replace(/^https?:\/\//, "");

export function DomainsPage() {
  const { t } = useTranslation(["domains", "common"]);
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const { data, isPending, isError, error, refetch } = useQuery(domainsOverviewQuery);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<OverviewDomain | null>(null);
  const [deleting, setDeleting] = useState<OverviewDomain | null>(null);
  const [filter, setFilter] = useState<VisualState | null>(null);

  const domains = data?.domains ?? [];
  const counts = useMemo(() => countStates(domains.map((domain) => tlsStates[domain.tls])), [domains]);
  const sorted = useMemo(
    () =>
      [...domains].sort(
        (a, b) => stateRank(tlsStates[a.tls]) - stateRank(tlsStates[b.tls]) || a.host.localeCompare(b.host),
      ),
    [domains],
  );
  const shown = filter === null ? sorted : sorted.filter((domain) => tlsStates[domain.tls] === filter);

  const remove = async () => {
    if (deleting === null) {
      return false;
    }
    await (deleting.destination === "custom"
      ? overviewApi.deleteCustom(deleting.id)
      : overviewApi.deleteService(deleting.projectName, deleting.serviceName, deleting.id));
    await queryClient.invalidateQueries({ queryKey: domainsOverviewKey });
    toast.success(t("deleted"));
    return true;
  };

  const managed = data?.managedProjects ?? null;
  const canAdd = data !== undefined && (managed === null || managed.length > 0);
  const canChange = (domain: OverviewDomain) =>
    domain.destination === "custom"
      ? user?.role === "admin"
      : managed === null || managed.includes(domain.projectName);

  const addButton = canAdd ? (
    <Button
      variant="primary"
      icon={<Plus aria-hidden="true" className="size-4" />}
      onClick={() => setCreating(true)}
    >
      {t("add")}
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} actions={addButton} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 px-4 py-6 md:px-6 lg:px-8">
        {isPending ? (
          <div className="grid gap-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : isError ? (
          <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
        ) : domains.length === 0 ? (
          <EmptyState
            illustration="no-domains"
            title={t("empty.title")}
            description={t("empty.description", { ip: data.serverIp ?? t("empty.yourServer") })}
            action={addButton}
          />
        ) : (
          <>
            <HealthSummary counts={counts} selected={filter} onSelect={setFilter} />
            <ul className="border-t">
              {shown.map((domain) => (
                <DomainRow
                  key={`${domain.destination}:${domain.id}`}
                  domain={domain}
                  canChange={canChange(domain)}
                  onEdit={() => setEditing(domain)}
                  onDelete={() => setDeleting(domain)}
                />
              ))}
            </ul>
            {data.serverIp !== null && (
              <p className="text-xs text-muted">{t("dnsHint", { ip: data.serverIp })}</p>
            )}
          </>
        )}
      </div>
      <DomainFormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        domain={editing}
        serverIp={data?.serverIp ?? null}
        canManageCustom={user?.role === "admin"}
        managedProjects={managed}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("deleteTitle")}
        description={deleting === null ? undefined : t("deleteDescription", { host: hostLabel(deleting) })}
        confirmLabel={t("remove")}
        onConfirm={remove}
      />
    </>
  );
}

function stateRank(state: VisualState): number {
  return ["failed", "degraded", "unknown", "progress", "running", "stopped"].indexOf(state);
}
