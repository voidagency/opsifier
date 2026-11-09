import { useQuery } from "@tanstack/react-query";
import { credentialsQuery, databaseQuery } from "../../../databases/api";
import { useDatabaseParams } from "../../../databases/DatabaseLayout";
import { LogsPanel } from "../../../service-runtime/LogsPanel";
import { serviceQuery } from "../../api";
import { NotesSection } from "../../NotesSection";
import { ServiceNotice } from "../../ServiceNotice";
import { CompanionCards } from "../companions/CompanionCards";
import { ConnectionPanel } from "./ConnectionPanel";
import { VersionPanel } from "./VersionPanel";

/** Connection state, notes, the logs panel and the web tools, in the order they are most often needed. */
export function DatabaseOverviewTab() {
  const { project, service } = useDatabaseParams();
  const { data: detail } = useQuery(serviceQuery(project, service));
  const { data: credentials } = useQuery(credentialsQuery(project, service));
  const { data: database } = useQuery(databaseQuery(project, service));

  if (detail === undefined) {
    return null;
  }

  return (
    <div className="grid gap-px">
      <ServiceNotice detail={detail} />
      {credentials !== undefined && (
        <section className="border-b px-4 py-6 md:px-6 lg:px-8">
          <ConnectionPanel detail={detail} credentials={credentials} />
        </section>
      )}
      {database !== undefined && (
        <section className="border-b px-4 py-6 md:px-6 lg:px-8">
          <VersionPanel versions={database.versions} />
        </section>
      )}
      <NotesSection detail={detail} />
      <section className="border-b px-4 py-6 md:px-6 lg:px-8">
        <LogsPanel project={project} service={service} />
      </section>
      <section className="px-4 py-6 md:px-6 lg:px-8">
        <CompanionCards busy={detail.activeAction !== null} />
      </section>
    </div>
  );
}
