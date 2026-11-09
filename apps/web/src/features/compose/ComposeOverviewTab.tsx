import type { ComposeChild } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { Maximize2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  countStates,
  EmptyState,
  ErrorState,
  HealthSummary,
  Lamp,
  MonoValue,
  Skeleton,
  Tooltip,
} from "../../ui";
import { LiveControls, LogsFullscreen, useLogFilter } from "../service-runtime/LogsPanel";
import { LogLines, LogScope } from "../service-runtime/LogView";
import { type LogView, useServiceLogs } from "../service-runtime/logStore";
import { serviceQuery, useServiceParams } from "../services/api";
import { NotesSection } from "../services/NotesSection";
import { composeRuntimeQuery } from "./api";
import { childVisualState } from "./state";

function ChildRow({
  child,
  address,
  selected,
  onSelect,
}: {
  child: ComposeChild;
  address: string | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("compose");
  const [container] = child.containers;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2.5 last:border-b-0">
      <Lamp
        state={childVisualState[child.state]}
        size="md"
        label={`${child.name}: ${t(`states.${child.state}`)}`}
      />
      <div className="min-w-0">
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          className="font-mono text-sm font-medium hover:underline aria-pressed:underline"
        >
          {child.name}
        </button>
        {child.containers.length > 1 && (
          <span className="ml-2 font-mono text-xs text-muted">×{child.containers.length}</span>
        )}
        {container !== undefined && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 text-xs text-muted">
            <span className="truncate font-mono" title={container.image}>
              {container.image}
            </span>
            <span>{container.status}</span>
            {container.ports.length > 0 && <span className="font-mono">{container.ports.join(" ")}</span>}
          </div>
        )}
      </div>
      {address !== undefined && (
        <MonoValue
          value={address}
          copy
          copyLabel={t("overview.copyAddress")}
          truncate
          className="max-w-[330px] text-xs text-muted"
        />
      )}
    </li>
  );
}

/** One child's lines, or all of them: the store is shared, so this only filters what is shown. */
function filterView(view: LogView, child: string | null): LogView {
  if (child === null) {
    return view;
  }
  return {
    ...view,
    entries: view.entries.filter((entry) => entry.kind !== "line" || entry.text.startsWith(`${child}-`)),
  };
}

function StackLogs({ project, service, child }: { project: string; service: string; child: string | null }) {
  const { t } = useTranslation("service-runtime");
  const { store, view } = useServiceLogs(project, service);
  const [fullscreen, setFullscreen] = useState(false);
  const ofChild = useMemo(() => filterView(view, child), [view, child]);
  const filter = useLogFilter(ofChild);

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="eyebrow">{t("logs.heading")}</h2>
        <LogScope project={project} service={service} view={view} />
      </div>
      <LiveControls store={store} view={view} filter={filter}>
        <Tooltip content={t("logs.fullscreen")}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("logs.fullscreen")}
            onClick={() => setFullscreen(true)}
          >
            <Maximize2 aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
      </LiveControls>
      <LogLines
        view={filter.shown}
        name={`${project}_${service}`}
        className="h-[450px]"
        filtered={filter.active}
      />
      <LogsFullscreen project={project} service={service} open={fullscreen} onOpenChange={setFullscreen} />
    </section>
  );
}

/** The state of every child, problems first, and the live logs of one or all of them. */
export function ComposeOverviewTab() {
  const { t } = useTranslation(["compose", "common"]);
  const { project, service } = useServiceParams();
  const { data, isPending, isError, error, refetch } = useQuery({
    ...composeRuntimeQuery(project, service),
    refetchInterval: 3000,
  });
  const { data: detail } = useQuery(serviceQuery(project, service));
  const [selected, setSelected] = useState<string | null>(null);

  if (isPending) {
    return (
      <div className="grid max-w-[1100px] gap-3 px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-10" />
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

  const child = selected !== null && data.children.some((item) => item.name === selected) ? selected : null;
  const counts = countStates(data.children.map((item) => childVisualState[item.state]));

  return (
    <div className="grid gap-px">
      {detail !== undefined && <NotesSection detail={detail} />}
      <section className="grid max-w-[1100px] gap-3 px-4 py-6 md:px-6 lg:px-8">
        {data.children.length === 0 ? (
          <EmptyState
            illustration="no-deployments"
            title={t("overview.children")}
            description={t("overview.noChildren")}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-md font-medium">{t("overview.children")}</h2>
              <HealthSummary variant="row" counts={counts} label={t("overview.children")} />
            </div>
            <ul className="border-y">
              {data.children.map((item) => (
                <ChildRow
                  key={item.name}
                  child={item}
                  address={data.addresses[item.name]}
                  selected={child === item.name}
                  onSelect={() => setSelected(child === item.name ? null : item.name)}
                />
              ))}
            </ul>
          </>
        )}
      </section>
      <div className="px-4 pb-6 md:px-6 lg:px-8">
        <fieldset className="m-0 mb-2 flex flex-wrap gap-1.5 border-0 p-0">
          <legend className="sr-only">{t("overview.filter")}</legend>
          <FilterChip active={child === null} onClick={() => setSelected(null)} label={t("overview.all")} />
          {data.children.map((item) => (
            <FilterChip
              key={item.name}
              active={child === item.name}
              onClick={() => setSelected(item.name)}
              label={item.name}
              mono
            />
          ))}
        </fieldset>
        <StackLogs key={`${project}/${service}`} project={project} service={service} child={child} />
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  mono = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`h-7 rounded-sm border border-off px-2.5 text-xs text-muted hover:text-ink aria-pressed:bg-wash aria-pressed:font-medium aria-pressed:text-ink ${mono ? "font-mono" : ""}`}
    >
      {label}
    </button>
  );
}
