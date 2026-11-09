import type {
  DockerCleanupKind,
  DockerUpdateCheck,
  ProxyDashboard,
  ServerOverview,
  TrustedProxiesSettings,
} from "@opsifier/contract";
import {
  dockerCleanupKinds,
  panelUpdateStatus,
  serverConfirmWords,
  systemLogsTopic,
} from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Info, Minus, RotateCw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { formatBytes } from "../../../lib/format";
import { errorMessage, useForm } from "../../../lib/forms";
import {
  Button,
  Checkbox,
  CodeEditor,
  ConfirmDialog,
  CopyButton,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorState,
  Field,
  FormBanner,
  GaugeBar,
  Input,
  Lamp,
  MonoValue,
  Select,
  Skeleton,
  Switch,
  Tooltip,
  toast,
  type VisualState,
} from "../../../ui";
import { useCurrentUser } from "../../auth/session";
import { FullscreenPanel } from "../../service-runtime/FullscreenPanel";
import { LogLines } from "../../service-runtime/LogView";
import { LogStore } from "../../service-runtime/logStore";
import type { TerminalStatus } from "../../service-runtime/TerminalPane";
import {
  cleanupPreviewQuery,
  customConfigQuery,
  dashboardQuery,
  diskQuery,
  dockerUpdateQuery,
  letsEncryptQuery,
  panelDomainQuery,
  proxyEnvQuery,
  serverApi,
  serverKey,
  serverOverviewQuery,
  serviceDomainQuery,
  trustedProxiesQuery,
} from "./api";

const TerminalPane = lazy(() => import("../../service-runtime/TerminalPane"));

/** The usual choices for how many versions to keep, and whatever is set if it is none of those. */
function releasesKeptOptions(current: number) {
  return [...new Set([1, 2, 3, 5, 10, 20, 50, current])]
    .sort((a, b) => a - b)
    .map((value) => ({ value: String(value), label: String(value) }));
}

const CLOUDFLARE = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];
const FASTLY = [
  "23.235.32.0/20",
  "43.249.72.0/22",
  "103.244.50.0/24",
  "103.245.222.0/23",
  "103.245.224.0/24",
  "104.156.80.0/20",
  "146.75.0.0/17",
  "151.101.0.0/16",
  "157.52.64.0/18",
  "167.82.0.0/17",
  "167.82.128.0/20",
  "167.82.160.0/20",
  "167.82.224.0/20",
  "172.111.64.0/18",
  "185.31.16.0/22",
  "199.27.72.0/21",
  "199.232.0.0/16",
];
const LOCALHOST = ["127.0.0.1/32", "::1/128"];

function uptimeOf(seconds: number | null) {
  if (seconds === null) {
    return null;
  }
  return {
    days: Math.floor(seconds / 86_400),
    hours: Math.floor((seconds % 86_400) / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
  };
}

const proxyStates: Record<ServerOverview["proxy"]["state"], VisualState> = {
  running: "running",
  starting: "progress",
  failing: "failed",
  missing: "stopped",
  unknown: "unknown",
};

function Menu({ label, state, children }: { label: string; state?: VisualState; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-off px-3 text-sm font-medium hover:bg-wash data-[state=open]:bg-wash">
        {state !== undefined && <Lamp state={state} size="xs" still decorative />}
        {label}
        <ChevronDown aria-hidden="true" className="size-3.5 text-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One live log, opened from a menu. Add a divider, refresh, or close it. */
function SystemLogsDialog({
  name,
  open,
  onOpenChange,
}: {
  name: "panel" | "proxy";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("settings-general");
  const store = useMemo(() => new LogStore(systemLogsTopic(name)), [name]);
  useEffect(() => (open ? store.retain() : undefined), [open, store]);
  const view = useSyncExternalStore(store.subscribe, store.getView);
  return (
    <FullscreenPanel
      open={open}
      onOpenChange={onOpenChange}
      title={t(`logs.${name}`)}
      actions={
        <>
          <Tooltip content={t("logs.divider")}>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("logs.divider")}
              onClick={() => store.addSeparator()}
            >
              <Minus aria-hidden="true" className="size-4" />
            </Button>
          </Tooltip>
          <Tooltip content={t("logs.refresh")}>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("logs.refresh")}
              onClick={() => store.refresh()}
            >
              <RotateCw aria-hidden="true" className="size-4" />
            </Button>
          </Tooltip>
        </>
      }
    >
      {open && (
        <LogLines
          view={view}
          name={name === "panel" ? "opsifier" : "opsifier-traefik"}
          className="min-h-0 flex-1"
        />
      )}
    </FullscreenPanel>
  );
}

function ConsoleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("settings-general");
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  return (
    <FullscreenPanel
      open={open}
      onOpenChange={onOpenChange}
      title={t("console.title")}
      keepOnEscape={status === "connected"}
      actions={
        <Lamp
          state={status === "connected" ? "running" : status === "ended" ? "stopped" : "progress"}
          showLabel
          label={t(`console.${status}`)}
        />
      }
    >
      {open && (
        <Suspense fallback={<Skeleton className="flex-1" />}>
          <TerminalPane
            project=""
            service=""
            task="host"
            target={{ program: "sh" }}
            socketPath="/api/v1/terminal/host"
            messages={{
              ended: (code) => t("console.ended", { code }),
              lost: t("console.lost"),
              refused: t("console.refused"),
            }}
            onStatus={setStatus}
          />
        </Suspense>
      )}
    </FullscreenPanel>
  );
}

function DiskUsageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(["settings-general", "common"]);
  const [path, setPath] = useState("/");
  useEffect(() => {
    if (open) {
      setPath("/");
    }
  }, [open]);
  const { data, isPending, isError, error, refetch } = useQuery({ ...diskQuery(path), enabled: open });
  const largest = Math.max(1, ...(data?.entries ?? []).map((entry) => entry.sizeBytes));
  return (
    <FullscreenPanel open={open} onOpenChange={onOpenChange} title={t("disk.title")}>
      {isPending ? (
        <Skeleton className="h-64" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : (
        <div className="grid min-h-0 gap-3 overflow-y-auto">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {data.parent !== null && (
              <Button size="sm" onClick={() => setPath(data.parent as string)}>
                {t("disk.up")}
              </Button>
            )}
            <MonoValue value={data.path} />
            <span className="text-muted">
              {data.scope === "data" ? t("disk.scopeData") : t("disk.scopeHost")}
            </span>
          </p>
          <ul className="border-t">
            {data.entries.map((entry) => (
              <li
                key={entry.path}
                className="grid grid-cols-[minmax(0,1fr)_14rem] items-center gap-3 border-b py-1.5 last:border-b-0"
              >
                {entry.directory ? (
                  <button
                    type="button"
                    className="truncate text-left font-mono text-xs hover:underline hover:underline-offset-4"
                    onClick={() => setPath(entry.path)}
                  >
                    {entry.name}/
                  </button>
                ) : (
                  <span className="truncate font-mono text-xs text-muted">{entry.name}</span>
                )}
                <GaugeBar
                  value={entry.sizeBytes}
                  max={largest}
                  label={entry.name}
                  display={formatBytes(entry.sizeBytes)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </FullscreenPanel>
  );
}

function CleanupDialog({ kind, onClose }: { kind: DockerCleanupKind | null; onClose: () => void }) {
  const { t } = useTranslation(["settings-general", "common"]);
  const queryClient = useQueryClient();
  const open = kind !== null;
  const { data, isPending, isError, error } = useQuery({
    ...cleanupPreviewQuery(kind ?? "images"),
    enabled: open,
  });
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== null) {
      setUnchecked(new Set());
      setTyped("");
      setFailure(null);
    }
  }, [kind]);

  const selected = (data?.items ?? []).filter((item) => !unchecked.has(item.id));
  const word = kind ?? "";

  const run = async () => {
    if (kind === null) {
      return;
    }
    setRunning(true);
    setFailure(null);
    try {
      await serverApi.runCleanup(
        kind,
        typed,
        selected.map((item) => item.id),
      );
      await queryClient.invalidateQueries({ queryKey: serverKey });
      toast.success(t("cleanup.started"));
      onClose();
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={kind === null ? "" : t(`cleanup.${kind}.title`)}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="danger"
            disabledReason={
              selected.length === 0
                ? t("cleanup.selectFirst")
                : typed !== word
                  ? t("cleanup.typeFirst", { word })
                  : undefined
            }
            pending={running}
            onClick={run}
          >
            {t("cleanup.remove", { count: selected.length })}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {failure && <FormBanner>{failure}</FormBanner>}
        {kind !== null && <p className="text-sm text-muted">{t(`cleanup.${kind}.description`)}</p>}
        {isPending ? (
          <Skeleton className="h-24" />
        ) : isError ? (
          <FormBanner>{errorMessage(error, t)}</FormBanner>
        ) : (
          <>
            {data.items.length === 0 ? (
              <p className="text-sm">{t("cleanup.nothing")}</p>
            ) : (
              <ul className="grid max-h-56 gap-1 overflow-y-auto">
                {data.items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3">
                    <Checkbox
                      label={<span className="font-mono text-xs">{item.label}</span>}
                      checked={!unchecked.has(item.id)}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setUnchecked((current) => {
                          const next = new Set(current);
                          if (checked) {
                            next.delete(item.id);
                          } else {
                            next.add(item.id);
                          }
                          return next;
                        });
                      }}
                    />
                    {item.sizeBytes !== null && (
                      <span className="font-mono text-xs text-muted">{formatBytes(item.sizeBytes)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">
              {t("cleanup.summary", {
                retained: data.retained.length,
                foreign: data.foreignCount,
                size: formatBytes(data.reclaimableBytes),
              })}
            </p>
            {data.items.length > 0 && (
              <Field
                label={
                  <>
                    {t("common:confirm.typeToConfirm")} <MonoValue value={word} className="font-medium" />
                  </>
                }
                hint={t("cleanup.typeHint")}
              >
                <Input
                  mono
                  value={typed}
                  onChange={(event) => setTyped(event.currentTarget.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </Field>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function DockerUpdateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["settings-general", "common"]);
  const { data, isPending, isError, error } = useQuery({ ...dockerUpdateQuery, enabled: open });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("docker.updatesTitle")}
      footer={<Button onClick={() => onOpenChange(false)}>{t("common:actions.close")}</Button>}
    >
      {isPending ? (
        <Skeleton className="h-10" />
      ) : isError ? (
        <FormBanner>{errorMessage(error, t)}</FormBanner>
      ) : (
        <DockerUpdateBody check={data} />
      )}
    </Dialog>
  );
}

function DockerUpdateBody({ check }: { check: DockerUpdateCheck }) {
  const { t } = useTranslation("settings-general");
  return (
    <div className="grid gap-2">
      <Lamp
        state={check.problem !== null ? "unknown" : check.upToDate ? "running" : "degraded"}
        size="md"
        showLabel
        label={
          check.problem !== null
            ? t("docker.checkFailed")
            : check.upToDate
              ? t("docker.upToDate", { version: check.current })
              : t("docker.newer", { version: check.latest })
        }
      />
      {check.problem !== null && <p className="text-sm text-muted">{check.problem}</p>}
      {check.engine.warnings.includes("too-old") && (
        <FormBanner tone="error">{t("docker.tooOld", { minimum: check.engine.minimumVersion })}</FormBanner>
      )}
      <p className="text-xs text-muted">{t("docker.upgradeHint")}</p>
    </div>
  );
}

function TrustedProxiesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["settings-general", "common"]);
  const queryClient = useQueryClient();
  const { data } = useQuery({ ...trustedProxiesQuery, enabled: open });
  const [trustAll, setTrustAll] = useState(false);
  const [text, setText] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && data !== undefined) {
      setTrustAll(data.trustAll);
      setText(data.entries.join("\n"));
      setFailure(null);
    }
  }, [open, data]);

  const entries = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const addPreset = (preset: readonly string[]) => setText([...new Set([...entries, ...preset])].join("\n"));
  const hasAll = (preset: readonly string[]) => preset.every((entry) => entries.includes(entry));

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      await serverApi.saveTrusted({ trustAll, entries } satisfies TrustedProxiesSettings);
      await queryClient.invalidateQueries({ queryKey: serverKey });
      toast.success(t("proxy.restarting"));
      onOpenChange(false);
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setSaving(false);
    }
  };

  const presets = [
    { label: "Cloudflare", entries: CLOUDFLARE },
    { label: "Fastly", entries: FASTLY },
    { label: "Localhost", entries: LOCALHOST },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("proxy.trustedTitle")}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.close")}
          </Button>
          <Button variant="primary" pending={saving} onClick={save}>
            {t("proxy.saveAndRestart")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {failure && <FormBanner>{failure}</FormBanner>}
        <Switch
          label={t("proxy.trustAll")}
          hint={t("proxy.trustAllHint")}
          checked={trustAll}
          onCheckedChange={setTrustAll}
        />
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <Button
              key={preset.label}
              size="sm"
              disabledReason={hasAll(preset.entries) ? t("proxy.presetAdded") : undefined}
              onClick={() => addPreset(preset.entries)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <Field label={t("proxy.entries")} hint={t("proxy.restartNote")}>
          <textarea
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            rows={8}
            className="w-full rounded-sm border border-off bg-raised p-2 font-mono text-xs"
          />
        </Field>
      </div>
    </Dialog>
  );
}

function CustomConfigDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["settings-general", "common"]);
  const { data } = useQuery({ ...customConfigQuery, enabled: open });
  const [yaml, setYaml] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open && data !== undefined) {
      setYaml(data.yaml);
      setFailure(null);
    }
  }, [open, data]);
  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      await serverApi.saveCustomConfig(yaml);
      toast.success(t("proxy.saved"));
      onOpenChange(false);
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("proxy.customTitle")}
      description={t("proxy.customDescription")}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.close")}
          </Button>
          <Button variant="primary" pending={saving} onClick={save}>
            {t("save")}
          </Button>
        </>
      }
    >
      {failure && <FormBanner className="mb-3">{failure}</FormBanner>}
      {open && (
        <CodeEditor
          label={t("proxy.customTitle")}
          value={yaml}
          onChange={setYaml}
          language="plain"
          className="h-72"
        />
      )}
    </Dialog>
  );
}

function EnvironmentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(["settings-general", "common"]);
  const queryClient = useQueryClient();
  const { data } = useQuery({ ...proxyEnvQuery, enabled: open });
  const [env, setEnv] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setEnv("");
      setRevealed(false);
      setFailure(null);
    }
  }, [open]);
  // With nothing set there is nothing to reveal.
  useEffect(() => {
    if (open && data !== undefined && data.names.length === 0) {
      setRevealed(true);
    }
  }, [open, data]);
  const reveal = async () => {
    try {
      setEnv((await serverApi.revealProxyEnv()).env);
      setRevealed(true);
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    }
  };
  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      await serverApi.saveProxyEnv(env);
      await queryClient.invalidateQueries({ queryKey: serverKey });
      toast.success(t("proxy.savedEnv"));
      onOpenChange(false);
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("proxy.envTitle")}
      description={t("proxy.envDescription")}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.close")}
          </Button>
          <Button
            variant="primary"
            pending={saving}
            disabledReason={revealed ? undefined : t("proxy.revealFirst")}
            onClick={save}
          >
            {t("save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {failure && <FormBanner>{failure}</FormBanner>}
        {!revealed ? (
          <div className="grid justify-items-start gap-2">
            <p className="text-sm">
              {data === undefined || data.names.length === 0
                ? t("proxy.envEmpty")
                : t("proxy.envNames", { names: data.names.join(", ") })}
            </p>
            <Button onClick={reveal}>{t("proxy.envReveal")}</Button>
          </div>
        ) : (
          <textarea
            value={env}
            onChange={(event) => setEnv(event.currentTarget.value)}
            rows={10}
            className="w-full rounded-sm border border-off bg-raised p-2 font-mono text-xs"
            spellCheck={false}
          />
        )}
      </div>
    </Dialog>
  );
}

function DashboardDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(["settings-general", "common"]);
  const queryClient = useQueryClient();
  const { data, refetch } = useQuery({ ...dashboardQuery, enabled: open });
  const [opened, setOpened] = useState<ProxyDashboard | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setOpened(null);
      setFailure(null);
    }
  }, [open]);
  const openIt = async () => {
    try {
      setOpened(await serverApi.openDashboard());
      await refetch();
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    }
  };
  const closeIt = async () => {
    await serverApi.closeDashboard();
    await queryClient.invalidateQueries({ queryKey: serverKey });
    toast.success(t("proxy.dashboardClosed"));
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("proxy.dashboardTitle")}
      footer={<Button onClick={() => onOpenChange(false)}>{t("common:actions.close")}</Button>}
    >
      <div className="grid gap-3">
        {failure && <FormBanner>{failure}</FormBanner>}
        <p className="text-sm text-muted">{t("proxy.dashboardDescription")}</p>
        {opened !== null ? (
          <div className="grid gap-2">
            <Field label={t("proxy.dashboardUrl")} hint={t("proxy.dashboardUrlHint")}>
              <div className="flex items-center gap-2">
                <Input mono readOnly value={opened.url} />
                <CopyButton value={opened.url} />
              </div>
            </Field>
            <Field label={t("proxy.dashboardUser")} hint={t("proxy.dashboardUserHint")}>
              <Input mono readOnly value={opened.username} />
            </Field>
            <Field label={t("proxy.dashboardPassword")} hint={t("proxy.dashboardOnce")}>
              <div className="flex items-center gap-2">
                <Input mono readOnly value={opened.password} />
                <CopyButton value={opened.password} />
              </div>
            </Field>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button variant="primary" onClick={openIt}>
              {t("proxy.dashboardOpen")}
            </Button>
            {data?.open === true && <Button onClick={closeIt}>{t("proxy.dashboardClose")}</Button>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ServerStrip() {
  const { t } = useTranslation(["settings-general", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(serverOverviewQuery);
  const hostRightReason = useCurrentUser()?.hostAdmin ? undefined : t("menu.needsHostAdmin");
  type Open =
    | "panel-logs"
    | "proxy-logs"
    | "console"
    | "disk"
    | "trusted"
    | "custom"
    | "env"
    | "dashboard"
    | "docker-update"
    | null;
  const [open, setOpen] = useState<Open>(null);
  const [confirm, setConfirm] = useState<"restart-panel" | "restart-proxy" | "reboot" | null>(null);
  const [cleanup, setCleanup] = useState<DockerCleanupKind | null>(null);

  const close = useCallback((value: boolean) => {
    if (!value) {
      setOpen(null);
    }
  }, []);

  const toggleCleanup = async (enabled: boolean) => {
    try {
      await serverApi.setDailyCleanup(enabled);
      await queryClient.invalidateQueries({ queryKey: serverKey });
    } catch (failure) {
      toast.error(errorMessage(failure, t));
    }
  };

  const saveReleasesKept = async (keep: string) => {
    try {
      await serverApi.setReleasesKept(Number(keep));
      await queryClient.invalidateQueries({ queryKey: serverKey });
      toast.success(t("releasesKeptSaved"));
    } catch (failure) {
      toast.error(errorMessage(failure, t));
    }
  };

  const checkPanelUpdate = async () => {
    toast.success(t("updates.checking"));
    try {
      const status = await api.post("/system/update/check", { schema: panelUpdateStatus });
      if (status.checkError !== null) {
        toast.error(status.checkError);
      } else if (status.updateAvailable) {
        toast.success(t("updates.available", { version: status.latest?.version ?? "" }));
      } else {
        toast.success(t("updates.current"));
      }
    } catch (failure) {
      toast.error(errorMessage(failure, t));
    }
  };

  const refreshIp = async () => {
    try {
      const entry = await serverApi.refreshIp();
      await queryClient.invalidateQueries();
      toast.success(entry.title);
    } catch (failure) {
      toast.error(errorMessage(failure, t));
    }
  };

  if (isPending) {
    return <Skeleton className="h-16" />;
  }
  if (isError) {
    return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }

  const uptime = uptimeOf(data.uptimeSeconds);
  const engine = data.docker;
  const dockerState: VisualState = !engine.available
    ? "failed"
    : engine.warnings.length > 0
      ? "degraded"
      : "running";

  return (
    <section className="grid gap-3 border-b pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <Menu label={t("menus.panel")}>
          <DropdownMenuItem onSelect={() => setOpen("panel-logs")}>{t("menu.logs")}</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setConfirm("restart-panel")}
            disabledReason={data.panel.managed ? undefined : t("menu.restartNotManaged")}
          >
            {t("menu.restart")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={refreshIp}>{t("menu.refreshIp")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={checkPanelUpdate}>{t("menu.checkUpdates")}</DropdownMenuItem>
        </Menu>
        <Menu label={t("menus.server")}>
          <DropdownMenuItem onSelect={() => setOpen("console")} disabledReason={hostRightReason}>
            {t("menu.console")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen("disk")} disabledReason={hostRightReason}>
            {t("menu.disk")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            destructive
            onSelect={() => setConfirm("reboot")}
            disabledReason={hostRightReason}
          >
            {t("menu.reboot")}
          </DropdownMenuItem>
        </Menu>
        <Menu label={t("menus.proxy")} state={proxyStates[data.proxy.state]}>
          <DropdownMenuItem onSelect={() => setOpen("proxy-logs")}>{t("menu.logs")}</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setConfirm("restart-proxy")}
            disabledReason={data.proxy.state === "missing" ? t("menu.restartProxyMissing") : undefined}
          >
            {t("menu.restart")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen("trusted")}>{t("menu.trusted")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen("custom")}>{t("menu.custom")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen("env")}>{t("menu.environment")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen("dashboard")}>{t("menu.dashboard")}</DropdownMenuItem>
        </Menu>
        <Menu label={t("menus.docker")} state={dockerState}>
          <div className="px-2 py-1 font-mono text-xs text-muted">
            {engine.version === null ? t("docker.unavailable") : `Docker ${engine.version}`}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setOpen("docker-update")}>
            {t("menu.checkUpdates")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {dockerCleanupKinds.map((kind) => (
            <DropdownMenuItem key={kind} onSelect={() => setCleanup(kind)}>
              {t(`cleanup.${kind}.menu`)}
            </DropdownMenuItem>
          ))}
        </Menu>
        <div className="ml-auto flex items-center gap-4">
          <Switch
            label={t("dailyCleanup")}
            hint={t("dailyCleanupHint")}
            checked={data.dailyCleanup}
            onCheckedChange={toggleCleanup}
          />
          <div className="flex items-center gap-2">
            <label htmlFor="releases-kept" className="text-sm">
              {t("releasesKept")}
            </label>
            <Select
              id="releases-kept"
              aria-label={t("releasesKept")}
              value={String(data.releasesKept)}
              options={releasesKeptOptions(data.releasesKept)}
              onValueChange={saveReleasesKept}
            />
            <Tooltip content={t("releasesKeptHint")}>
              <button
                type="button"
                aria-label={t("releasesKeptHintLabel")}
                className="flex size-6 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
              >
                <Info aria-hidden="true" className="size-3.5" />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      <p className="text-sm text-muted">
        {uptime === null
          ? t("uptimeUnknown")
          : t("uptime", { days: uptime.days, hours: uptime.hours, minutes: uptime.minutes })}
      </p>
      {engine.warnings.length > 0 && (
        <FormBanner tone="error">
          {engine.available ? (
            <>
              {t("docker.missingIntro")}
              <ul className="mt-1 list-disc pl-5">
                {engine.missing.map((feature) => (
                  <li key={feature}>
                    {t(`docker.missing.${feature}`, {
                      version: engine.version,
                      minimum: engine.minimumVersion,
                      apiVersion: engine.apiVersion,
                      minimumApi: engine.minimumApiVersion,
                    })}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            t("docker.warnUnavailable")
          )}
        </FormBanner>
      )}

      <SystemLogsDialog name="panel" open={open === "panel-logs"} onOpenChange={close} />
      <SystemLogsDialog name="proxy" open={open === "proxy-logs"} onOpenChange={close} />
      <ConsoleDialog open={open === "console"} onOpenChange={close} />
      <DiskUsageDialog open={open === "disk"} onOpenChange={close} />
      <TrustedProxiesDialog open={open === "trusted"} onOpenChange={close} />
      <CustomConfigDialog open={open === "custom"} onOpenChange={close} />
      <EnvironmentDialog open={open === "env"} onOpenChange={close} />
      <DashboardDialog open={open === "dashboard"} onOpenChange={close} />
      <DockerUpdateDialog open={open === "docker-update"} onOpenChange={close} />
      <CleanupDialog kind={cleanup} onClose={() => setCleanup(null)} />

      <ConfirmDialog
        open={confirm === "restart-panel"}
        onOpenChange={(value) => !value && setConfirm(null)}
        title={t("confirm.panelTitle")}
        description={t("confirm.panelDescription")}
        confirmLabel={t("menu.restart")}
        confirmText={serverConfirmWords.panelRestart}
        onConfirm={async () => {
          await serverApi.restartPanel(serverConfirmWords.panelRestart);
          toast.success(t("confirm.panelDone"));
        }}
      />
      <ConfirmDialog
        open={confirm === "restart-proxy"}
        onOpenChange={(value) => !value && setConfirm(null)}
        title={t("confirm.proxyTitle")}
        description={t("confirm.proxyDescription")}
        confirmLabel={t("menu.restart")}
        confirmText={serverConfirmWords.proxyRestart}
        onConfirm={async () => {
          await serverApi.restartProxy(serverConfirmWords.proxyRestart);
          toast.success(t("confirm.proxyDone"));
        }}
      />
      <ConfirmDialog
        open={confirm === "reboot"}
        onOpenChange={(value) => !value && setConfirm(null)}
        title={t("confirm.rebootTitle")}
        description={t("confirm.rebootDescription")}
        confirmLabel={t("menu.reboot")}
        confirmText={serverConfirmWords.reboot}
        onConfirm={async () => {
          await serverApi.reboot(serverConfirmWords.reboot);
          toast.success(t("confirm.rebootDone"));
        }}
      />
    </section>
  );
}

function PanelDomainCard() {
  const { t } = useTranslation(["settings-general", "common"]);
  const queryClient = useQueryClient();
  const { data } = useQuery(panelDomainQuery);
  const [serveOnIp, setServeOnIp] = useState(true);
  const form = useForm({
    t,
    initialValues: { customDomain: "" },
    onSubmit: async ({ customDomain }) => {
      await serverApi.savePanelDomain({ customDomain, serveOnIp });
      await queryClient.invalidateQueries({ queryKey: serverKey });
      toast.success(t("saved"));
    },
  });
  const { reset } = form;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refill only when the stored value arrives
  useEffect(() => {
    if (data !== undefined) {
      reset({ customDomain: data.customDomain ?? "" });
      setServeOnIp(data.serveOnIp);
    }
  }, [data]);

  return (
    <SettingsSection title={t("panelDomain.title")} description={t("panelDomain.description")}>
      <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[650px] gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("defaultDomain")} hint={t("defaultDomainHint")}>
          <div className="flex items-center gap-2">
            <Input mono readOnly value={data?.defaultDomain ?? ""} />
            <CopyButton value={data?.defaultDomain ?? ""} />
          </div>
        </Field>
        <Field
          label={t("customDomain")}
          optional
          hint={t("panelDomain.hint")}
          error={form.errors.customDomain}
        >
          <Input {...form.field("customDomain")} mono placeholder="panel.example.com" autoCapitalize="none" />
        </Field>
        <Switch
          label={t("panelDomain.serveOnIp")}
          hint={t("panelDomain.serveOnIpHint")}
          checked={serveOnIp}
          onCheckedChange={setServeOnIp}
        />
        <div>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("save")}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function ServiceDomainCard() {
  const { t } = useTranslation(["settings-general", "common"]);
  const queryClient = useQueryClient();
  const { data } = useQuery(serviceDomainQuery);
  const form = useForm({
    t,
    initialValues: { customDomain: "" },
    onSubmit: async ({ customDomain }) => {
      await serverApi.saveServiceDomain({ customDomain });
      await queryClient.invalidateQueries({ queryKey: serverKey });
      toast.success(t("saved"));
    },
  });
  const { reset } = form;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refill only when the stored value arrives
  useEffect(() => {
    if (data !== undefined) {
      reset({ customDomain: data.customDomain ?? "" });
    }
  }, [data]);
  return (
    <SettingsSection title={t("serviceDomain.title")} description={t("serviceDomain.description")}>
      <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[650px] gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("defaultDomain")} hint={t("defaultDomainHint")}>
          <div className="flex items-center gap-2">
            <Input mono readOnly value={data?.defaultDomain ?? ""} />
            <CopyButton value={data?.defaultDomain ?? ""} />
          </div>
        </Field>
        <Field
          label={t("customDomain")}
          optional
          hint={t("serviceDomain.hint")}
          error={form.errors.customDomain}
        >
          <Input {...form.field("customDomain")} mono placeholder="apps.example.com" autoCapitalize="none" />
        </Field>
        <FormBanner tone="info">{t("serviceDomain.dns")}</FormBanner>
        <div>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("save")}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function LetsEncryptCard() {
  const { t } = useTranslation(["settings-general", "common"]);
  const { data } = useQuery(letsEncryptQuery);
  const form = useForm({
    t,
    initialValues: { email: "" },
    onSubmit: async ({ email }) => {
      await serverApi.saveEmail(email);
      toast.success(t("saved"));
    },
  });
  const { reset } = form;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refill only when the stored value arrives
  useEffect(() => {
    if (data !== undefined) {
      reset({ email: data.email });
    }
  }, [data]);
  return (
    <SettingsSection title={t("letsEncrypt.title")} description={t("letsEncrypt.description")}>
      <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[650px] gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("letsEncrypt.email")} error={form.errors.email} hint={t("letsEncrypt.emailHint")}>
          <Input {...form.field("email")} autoComplete="off" />
        </Field>
        <div>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("save")}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-x-10 gap-y-3 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
      <div>
        <h2 className="text-md font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** The server itself: its uptime, the four operations menus and where everything answers. */
export function GeneralPage() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 px-4 py-6 md:px-6 lg:px-8">
      <ServerStrip />
      <PanelDomainCard />
      <ServiceDomainCard />
      <LetsEncryptCard />
    </div>
  );
}
