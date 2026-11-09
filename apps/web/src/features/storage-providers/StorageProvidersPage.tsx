import type { StorageProviderEntry, StorageProviderKind } from "@opsifier/contract";
import { storageProviderKinds } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { ChevronDown, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  ConfirmDialog,
  countStates,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorState,
  HealthSummary,
  Lamp,
  MonoValue,
  Pictogram,
  type PictogramName,
  SectionIntro,
  Skeleton,
  Tooltip,
  toast,
  type VisualState,
} from "../../ui";
import { storageProvidersApi, storageProvidersKey, storageProvidersQuery } from "./api";
import { ProviderDialog } from "./ProviderDialog";

const pictogramOf: Record<StorageProviderKind, PictogramName> = {
  local: "disk",
  sftp: "network",
  ftp: "network",
  dropbox: "upload",
  "google-drive": "upload",
  "aws-s3": "volume",
  "cloudflare-r2": "volume",
  "digitalocean-spaces": "volume",
  "backblaze-b2": "volume",
  wasabi: "volume",
  "generic-s3": "volume",
};

function stateOf(provider: StorageProviderEntry): VisualState {
  if (provider.status === "disconnected") {
    return "stopped";
  }
  return provider.lastCheckError !== null ? "degraded" : "running";
}

/** Sort problems first, so a destination that stopped working can't hide among the good ones. */
const stateRank: Record<VisualState, number> = {
  failed: 0,
  degraded: 1,
  unknown: 2,
  progress: 3,
  running: 4,
  stopped: 5,
};

type Pending =
  | { kind: "create"; provider: StorageProviderKind }
  | { kind: "edit"; provider: StorageProviderEntry }
  | { kind: "delete"; provider: StorageProviderEntry }
  | { kind: "disconnect"; provider: StorageProviderEntry };

export function StorageProvidersPage() {
  const { t, i18n } = useTranslation(["storage-providers", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, error, refetch } = useQuery(storageProvidersQuery);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const search = useSearch({ strict: false }) as { connected?: string; oauthError?: string };

  // The provider sends the browser back here with the outcome in the address.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each outcome is reported once
  useEffect(() => {
    if (search.connected !== undefined) {
      toast.success(t("oauth.connected"));
      void queryClient.invalidateQueries({ queryKey: storageProvidersKey });
    }
    if (search.oauthError !== undefined) {
      toast.error(
        t("oauth.failed"),
        t(`oauth.errors.${search.oauthError}`, { defaultValue: "" }) || undefined,
      );
    }
  }, [search.connected, search.oauthError]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: storageProvidersKey });
  const close = () => setPending(null);

  const connect = async (provider: StorageProviderEntry) => {
    try {
      setBusy(provider.id);
      const { authorizationUrl } = await storageProvidersApi.connect(provider.id);
      window.location.assign(authorizationUrl);
    } catch (failure) {
      toast.error(t("oauth.failed"), errorMessage(failure, t));
      setBusy(null);
    }
  };

  const check = async (provider: StorageProviderEntry) => {
    setBusy(provider.id);
    try {
      const result = await storageProvidersApi.check(provider.id);
      if (result.ok) {
        toast.success(t("check.ok", { name: provider.name }));
      } else {
        toast.error(t("check.failed", { name: provider.name }), result.error ?? undefined);
      }
      await refresh();
    } catch (failure) {
      toast.error(t("check.failed", { name: provider.name }), errorMessage(failure, t));
    } finally {
      setBusy(null);
    }
  };

  const createMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="primary" icon={<Plus aria-hidden="true" className="size-4" />}>
          {t("create")}
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {storageProviderKinds.map((kind) => (
          <DropdownMenuItem key={kind} onSelect={() => setPending({ kind: "create", provider: kind })}>
            <Pictogram name={pictogramOf[kind]} size={16} className="text-muted" />
            {t(`kinds.${kind}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const body = () => {
    if (isPending) {
      return <Skeleton className="h-24" />;
    }
    if (data === undefined) {
      return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
    }
    const providers = [...data.providers].sort(
      (a, b) => stateRank[stateOf(a)] - stateRank[stateOf(b)] || a.name.localeCompare(b.name),
    );
    return (
      <div className="grid gap-5">
        <ul className="border-y" aria-label={t("listLabel")}>
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              busy={busy === provider.id}
              language={i18n.language}
              onEdit={() => setPending({ kind: "edit", provider })}
              onDelete={() => setPending({ kind: "delete", provider })}
              onCheck={() => check(provider)}
              onConnect={() => connect(provider)}
              onDisconnect={() => setPending({ kind: "disconnect", provider })}
            />
          ))}
        </ul>
      </div>
    );
  };

  const states = data === undefined ? [] : data.providers.map(stateOf);

  return (
    <section className="grid gap-6 px-4 py-6 md:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <SectionIntro pictogram="backup" title={t("title")} description={t("description")} />
          {states.length > 0 && (
            <HealthSummary variant="row" counts={countStates(states)} label={t("summary")} />
          )}
        </div>
        {createMenu}
      </div>
      {body()}

      {(pending?.kind === "create" || pending?.kind === "edit") && (
        <ProviderDialog
          kind={pending.kind === "create" ? pending.provider : pending.provider.kind}
          editing={pending.kind === "edit" ? pending.provider : undefined}
          redirectUrl={data?.oauthRedirectUrl ?? ""}
          onClose={close}
          onSaved={refresh}
        />
      )}

      <ConfirmDialog
        open={pending?.kind === "delete"}
        onOpenChange={(open) => !open && close()}
        title={t("delete.title")}
        description={
          pending?.kind === "delete" ? t("delete.description", { name: pending.provider.name }) : undefined
        }
        confirmLabel={t("delete.confirm")}
        onConfirm={async () => {
          if (pending?.kind === "delete") {
            await storageProvidersApi.remove(pending.provider.id);
            await refresh();
            toast.success(t("delete.done", { name: pending.provider.name }));
          }
        }}
      />

      <ConfirmDialog
        open={pending?.kind === "disconnect"}
        onOpenChange={(open) => !open && close()}
        title={t("disconnect.title")}
        description={
          pending?.kind === "disconnect"
            ? t("disconnect.description", { name: pending.provider.name })
            : undefined
        }
        confirmLabel={t("disconnect.confirm")}
        onConfirm={async () => {
          if (pending?.kind === "disconnect") {
            await storageProvidersApi.disconnect(pending.provider.id);
            await refresh();
            toast.success(t("disconnect.done", { name: pending.provider.name }));
          }
        }}
      />
    </section>
  );
}

function ProviderRow({
  provider,
  busy,
  language,
  onEdit,
  onDelete,
  onCheck,
  onConnect,
  onDisconnect,
}: {
  provider: StorageProviderEntry;
  busy: boolean;
  language: string;
  onEdit: () => void;
  onDelete: () => void;
  onCheck: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation(["storage-providers", "common"]);
  const state = stateOf(provider);
  const isOAuth = provider.kind === "dropbox" || provider.kind === "google-drive";

  return (
    <li className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2.5 last:border-b-0">
      <Lamp state={state} size="md" label={t(`state.${state}`)} />
      <Pictogram name={pictogramOf[provider.kind]} className="text-muted" />
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{provider.name}</span>
          <span className="text-xs text-muted">{t(`kinds.${provider.kind}`)}</span>
          {!provider.offHost && <span className="text-xs text-muted">{t("onServer")}</span>}
        </span>
        {provider.location !== "" && (
          <MonoValue value={provider.location} truncate className="text-xs text-muted" />
        )}
        {provider.lastCheckError !== null && (
          <Tooltip content={provider.lastCheckError}>
            <span className="max-w-[60ch] truncate text-xs text-bad">{provider.lastCheckError}</span>
          </Tooltip>
        )}
        {provider.status === "disconnected" && (
          <span className="text-xs text-muted">{t("notConnectedHint")}</span>
        )}
      </span>
      <span className="flex items-center gap-1">
        {isOAuth && provider.status === "disconnected" && (
          <Button onClick={onConnect} pending={busy}>
            {t("connect")}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("menuFor", { name: provider.name })}
            className="flex size-8 items-center justify-center rounded-sm hover:bg-wash data-[state=open]:bg-wash"
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {!provider.builtIn && <DropdownMenuItem onSelect={onEdit}>{t("edit")}</DropdownMenuItem>}
            <DropdownMenuItem disabled={busy} onSelect={onCheck}>
              {t("checkNow")}
            </DropdownMenuItem>
            {isOAuth && provider.status === "ready" && (
              <DropdownMenuItem onSelect={onDisconnect}>{t("disconnectAction")}</DropdownMenuItem>
            )}
            {!provider.builtIn && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={onDelete}>
                  {t("deleteAction")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {provider.lastCheckAt !== null && (
        <span className="sr-only">{formatDateTime(provider.lastCheckAt, language)}</span>
      )}
    </li>
  );
}
