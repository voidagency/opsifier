import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Markdown } from "../../../../ui";
import { LogsPanel } from "../../../service-runtime/LogsPanel";
import { serviceQuery, useServiceParams } from "../../api";
import { NotesDialog } from "../../NotesDialog";

/** Notes, and the service's live logs. */
export function OverviewTab() {
  const { t } = useTranslation("services");
  const { project, service } = useServiceParams();
  const { data: detail } = useQuery(serviceQuery(project, service));
  const [editing, setEditing] = useState(false);

  if (detail === undefined) {
    return null;
  }

  return (
    <div className="grid gap-px">
      {detail.notes !== "" && (
        <section className="grid gap-3 border-b px-4 py-6 md:px-6 lg:px-8">
          <div className="flex max-w-[720px] items-center justify-between gap-3">
            <h2 className="eyebrow">{t("notes.heading")}</h2>
            <Button size="sm" onClick={() => setEditing(true)}>
              {t("notes.edit")}
            </Button>
          </div>
          <Markdown text={detail.notes} className="grid max-w-[720px] gap-2 text-sm" />
          <NotesDialog
            project={project}
            service={service}
            notes={detail.notes}
            open={editing}
            onOpenChange={setEditing}
          />
        </section>
      )}
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <LogsPanel project={project} service={service} />
      </div>
    </div>
  );
}
