import type { DomainEntry, DomainTlsState } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Lamp,
  MonoValue,
  Pictogram,
  Skeleton,
  Tooltip,
  toast,
  type VisualState,
} from "../../../../ui";
import { DomainProtectionLamp } from "../../../server-purpose/ProtectionIndicator";
import { domainsQuery, serviceKey, useServiceParams } from "../../api";
import { domainsApi, domainTlsQuery } from "./api";
import { DomainDialog } from "./DomainDialog";

type Pending =
  | { kind: "create" }
  | { kind: "edit"; domain: DomainEntry }
  | { kind: "delete"; domain: DomainEntry }
  | { kind: "primary"; domain: DomainEntry };

const tlsStates: Record<DomainTlsState, VisualState> = {
  issued: "running",
  expiring: "degraded",
  expired: "failed",
  pending: "progress",
  none: "stopped",
  unreadable: "failed",
  unverified: "unknown",
};

/**
 * The certificate of a domain: its lamp, and in words what the lamp stands for. Only what the proxy
 * really holds counts, so a panel that can't find out says that, rather than what the domain asked for.
 */
function CertificateState({ domain, tls }: { domain: DomainEntry; tls: DomainTlsState | undefined }) {
  const { t } = useTranslation("service-domains");
  const label = !domain.https
    ? t("httpOnly")
    : tls === undefined
      ? t("certificate.unknown")
      : t(`certificate.${tls}`);
  const state = !domain.https ? "stopped" : tls === undefined ? "unknown" : tlsStates[tls];
  return (
    <span className="inline-flex items-center gap-1.5 text-muted" title={label}>
      <Pictogram name="certificate" size={16} />
      <Lamp state={state} label={label} />
    </span>
  );
}

function DomainRow({
  domain,
  tls,
  onEdit,
  onDelete,
  onMakePrimary,
}: {
  domain: DomainEntry;
  tls: DomainTlsState | undefined;
  onEdit: () => void;
  onDelete: () => void;
  onMakePrimary: () => void;
}) {
  const { t } = useTranslation("service-domains");
  return (
    <li className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-b py-2.5 last:border-b-0 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto]">
      <CertificateState domain={domain} tls={tls} />
      {domain.primary ? (
        <Tooltip content={t("primary")}>
          <span role="img" className="flex size-7 items-center justify-center" aria-label={t("primary")}>
            <Star aria-hidden="true" className="size-4 fill-current text-ink" />
          </span>
        </Tooltip>
      ) : domain.wildcard ? (
        <span aria-hidden="true" className="size-7" />
      ) : (
        <Tooltip content={t("makePrimary")}>
          <Button size="icon-sm" variant="ghost" aria-label={t("makePrimary")} onClick={onMakePrimary}>
            <Star aria-hidden="true" className="size-4 text-off" />
          </Button>
        </Tooltip>
      )}
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex min-w-0 items-center gap-2">
            <DomainProtectionLamp host={domain.host} path={domain.path} wildcard={domain.wildcard} />
            <MonoValue
              value={domain.url}
              copy
              copyLabel={t("copyUrl")}
              truncate
              className="min-w-0 text-sm"
            />
          </span>
          {!domain.https && <span className="text-xs whitespace-nowrap text-muted">{t("httpOnly")}</span>}
          {domain.wildcard && <Badge tone="accent">{t("wildcard")}</Badge>}
          {domain.stripPath && domain.path !== "/" && <Badge>{t("pathStripped")}</Badge>}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <span aria-hidden="true">→</span>
          <MonoValue value={domain.internalUrl} copy copyLabel={t("copyInternal")} truncate />
        </span>
      </span>
      <span className="col-span-full flex items-center justify-end gap-1 sm:col-span-1">
        {!domain.wildcard && (
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
        )}
        <Tooltip content={t("edit")}>
          <Button size="icon" variant="ghost" aria-label={t("edit")} onClick={onEdit}>
            <Pencil aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content={t("delete")}>
          <Button size="icon" variant="ghost" aria-label={t("delete")} onClick={onDelete}>
            <Trash2 aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
      </span>
    </li>
  );
}

export function DomainsTab({ composeServices }: { composeServices?: readonly string[] } = {}) {
  const { t } = useTranslation(["service-domains", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(domainsQuery(project, service));
  // What the proxy really holds. A panel that can't say falls back to what the domain is set up to do.
  const { data: tls } = useQuery(domainTlsQuery);
  const tlsById = useMemo(
    () =>
      new Map(
        tls?.domains.flatMap((domain) =>
          domain.destination === "service" ? [[domain.id, domain.tls] as const] : [],
        ),
      ),
    [tls],
  );
  const [pending, setPending] = useState<Pending | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
  const close = () => setPending(null);

  if (isPending) {
    return (
      <div className="grid max-w-[1100px] gap-3 px-4 py-6 md:px-6 lg:px-8">
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

  const add = (
    <Button
      variant="primary"
      icon={<Plus aria-hidden="true" className="size-4" />}
      onClick={() => setPending({ kind: "create" })}
    >
      {t("add")}
    </Button>
  );

  return (
    <div className="grid gap-6 px-4 py-6 md:px-6 lg:px-8">
      {data.domains.length === 0 ? (
        <EmptyState
          illustration="no-domains"
          title={t("empty.title")}
          description={t("empty.description")}
          action={add}
        />
      ) : (
        <div className="grid max-w-[1100px] gap-4">
          <ul className="border-y">
            {data.domains.map((domain) => (
              <DomainRow
                key={domain.id}
                domain={domain}
                tls={tlsById.get(domain.id)}
                onEdit={() => setPending({ kind: "edit", domain })}
                onDelete={() => setPending({ kind: "delete", domain })}
                onMakePrimary={() => setPending({ kind: "primary", domain })}
              />
            ))}
          </ul>
          <div>{add}</div>
        </div>
      )}

      <DomainDialog
        open={pending?.kind === "create" || pending?.kind === "edit"}
        project={project}
        service={service}
        domain={pending?.kind === "edit" ? pending.domain : undefined}
        composeServices={composeServices}
        onOpenChange={(open) => {
          if (!open) {
            close();
          }
        }}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={pending?.kind === "delete"}
        onOpenChange={(open) => !open && close()}
        title={t("deleteDialog.title")}
        description={
          pending?.kind === "delete" ? t("deleteDialog.description", { url: pending.domain.url }) : undefined
        }
        confirmLabel={t("deleteDialog.confirm")}
        onConfirm={async () => {
          if (pending?.kind === "delete") {
            await domainsApi.remove(project, service, pending.domain.id);
            await refresh();
            toast.success(t("deleted"));
          }
        }}
      />

      <ConfirmDialog
        open={pending?.kind === "primary"}
        onOpenChange={(open) => !open && close()}
        title={t("primaryDialog.title")}
        description={
          pending?.kind === "primary"
            ? t("primaryDialog.description", { host: pending.domain.host })
            : undefined
        }
        confirmLabel={t("primaryDialog.confirm")}
        tone="primary"
        onConfirm={async () => {
          if (pending?.kind === "primary") {
            await domainsApi.makePrimary(project, service, pending.domain.id);
            await refresh();
            toast.success(t("primaryMoved"), t("primaryMovedHint"));
          }
        }}
      />
    </div>
  );
}
