import { useTranslation } from "react-i18next";
import { EmptyState } from "../../../../ui";
import { BackupsPanel } from "../../../backups/BackupsPanel";
import { useDatabaseParams } from "../../../databases/DatabaseLayout";

/** The Backups tab of a database. Redis has no database to export, and its tab list says so by not showing this. */
export function BackupsTab() {
  const { t } = useTranslation("backups");
  const { project, service, engine } = useDatabaseParams();
  if (engine === "redis") {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <EmptyState illustration="no-backups" title={t("notAvailable")} />
      </div>
    );
  }
  return <BackupsPanel project={project} service={service} scope="database" />;
}
