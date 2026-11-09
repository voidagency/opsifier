import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { ErrorState, Lamp, MonoValue, Pictogram, type PictogramName, Skeleton } from "../../ui";
import { LogsPanel } from "../service-runtime/LogsPanel";
import { serviceQuery, useServiceParams } from "../services/api";
import { NotesSection } from "../services/NotesSection";
import { ServiceNotice } from "../services/ServiceNotice";
import { processVisualState } from "../services/tabs/box-processes/state";
import { boxIdeQuery, boxProcessesQuery, boxQuery } from "./api";

function Fact({ icon, title, children }: { icon: PictogramName; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <Pictogram name={icon} className="mt-0.5 text-muted" />
      <div className="min-w-0">
        <h3 className="font-medium">{title}</h3>
        <p className="mt-0.5 max-w-[60ch] text-muted">{children}</p>
      </div>
    </div>
  );
}

/** What is running in this box, and in words what it does for itself. */
export function BoxOverviewTab() {
  const { t } = useTranslation(["box", "service-box-processes"]);
  const { project, service } = useServiceParams();
  const { data: detail } = useQuery(serviceQuery(project, service));
  const box = useQuery(boxQuery(project, service));
  const processes = useQuery({ ...boxProcessesQuery(project, service), refetchInterval: 3000 });
  const ide = useQuery(boxIdeQuery(project, service));

  if (detail === undefined) {
    return null;
  }

  const summary = () => {
    if (box.isPending) {
      return <Skeleton className="h-16" />;
    }
    if (box.isError) {
      return <ErrorState message={errorMessage(box.error, t)} onRetry={() => box.refetch()} />;
    }
    const { runtime } = box.data;
    return (
      <div className="divide-y">
        <Fact icon="user" title={t("overview.identity.title")}>
          {t("overview.identity.body", { user: runtime.user, uid: runtime.uid, gid: runtime.gid })}
        </Fact>
        <Fact icon="volume" title={t("overview.storage.title")}>
          {t("overview.storage.body", { path: runtime.workspacePath })}
        </Fact>
        <Fact icon="editor" title={t("overview.ide.title")}>
          {t(`overview.ide.${ide.data?.access ?? "off"}`)}
        </Fact>
      </div>
    );
  };

  return (
    <div className="grid gap-px">
      <ServiceNotice detail={detail} />
      <section className="px-4 py-6 md:px-6 lg:px-8">
        <h2 className="text-md font-medium">{t("overview.running")}</h2>
        {processes.isPending ? (
          <Skeleton className="mt-3 h-6" />
        ) : processes.isError ? (
          <div className="mt-3">
            <ErrorState message={errorMessage(processes.error, t)} onRetry={() => processes.refetch()} />
          </div>
        ) : processes.data.processes.length === 0 ? (
          <p className="mt-2 text-muted">{t("overview.noProcesses")}</p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            {processes.data.processes.map((process) => (
              <li key={process.name} className="inline-flex items-center gap-2">
                <Lamp
                  state={processVisualState(process.state)}
                  size="md"
                  label={t(`service-box-processes:state.${process.state}`)}
                />
                <MonoValue value={process.name} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="border-t px-4 py-6 md:px-6 lg:px-8">
        <h2 className="text-md font-medium">{t("overview.howItRuns")}</h2>
        <div className="mt-2 max-w-[850px]">{summary()}</div>
      </section>
      <NotesSection detail={detail} />
      <div className="border-t px-4 py-6 md:px-6 lg:px-8">
        <LogsPanel project={project} service={service} />
      </div>
    </div>
  );
}
