import { useQuery } from "@tanstack/react-query";
import { LogsPanel } from "../../../service-runtime/LogsPanel";
import { serviceQuery, useServiceParams } from "../../api";
import { NotesSection } from "../../NotesSection";
import { ServiceNotice } from "../../ServiceNotice";

/** Notes, and the service's live logs. */
export function OverviewTab() {
  const { project, service } = useServiceParams();
  const { data: detail } = useQuery(serviceQuery(project, service));

  if (detail === undefined) {
    return null;
  }

  return (
    <div className="grid gap-px">
      <ServiceNotice detail={detail} />
      <NotesSection detail={detail} />
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <LogsPanel project={project} service={service} />
      </div>
    </div>
  );
}
