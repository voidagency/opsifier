import type { ServiceDetail } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { Button, Lamp, Markdown, toast } from "../../ui";
import { serviceKey, servicesApi } from "./api";
import { NotesDialog } from "./NotesDialog";

/** A service's notes, in the three states that must not be confused: none yet, put away and shown. */
export function NotesSection({ detail }: { detail: ServiceDetail }) {
  const { t } = useTranslation(["services", "common"]);
  const { projectName: project, name: service, notes, notesHidden } = detail;
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const empty = notes === "";

  const setHidden = async (hidden: boolean) => {
    try {
      await servicesApi.setNotesHidden(project, service, hidden);
      await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
    } catch (error) {
      toast.error(errorMessage(error, t));
    }
  };

  return (
    <section className="grid gap-3 border-b px-4 py-6 md:px-6 lg:px-8">
      <div className="flex max-w-[900px] flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="eyebrow">{t("notes.heading")}</h2>
        {empty ? (
          <span className="text-sm text-muted">{t("notes.empty")}</span>
        ) : (
          notesHidden && <Lamp state="stopped" still showLabel label={t("notes.hidden")} />
        )}
        <div className="ml-auto flex gap-1.5">
          {!empty && (
            <Button size="sm" variant="ghost" onClick={() => setHidden(!notesHidden)}>
              {notesHidden ? t("notes.show") : t("notes.hide")}
            </Button>
          )}
          <Button size="sm" onClick={() => setEditing(true)}>
            {empty ? t("notes.add") : t("notes.edit")}
          </Button>
        </div>
      </div>
      {!empty && !notesHidden && <Markdown text={notes} className="grid max-w-[900px] gap-2 text-sm" />}
      <NotesDialog
        project={project}
        service={service}
        notes={notes}
        open={editing}
        onOpenChange={setEditing}
      />
    </section>
  );
}
