import type { ActionEntry } from "@opsifier/contract";
import { useTranslation } from "react-i18next";
import { Dialog } from "../../ui";
import { ActionLog } from "./ActionLog";
import { actionLabel } from "./labels";

/** The full output of one Action, following along while it is still running. */
export function ActionLogDialog({ action, onClose }: { action: ActionEntry | null; onClose: () => void }) {
  const { t } = useTranslation("activity");
  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      size="lg"
      title={action === null ? "" : actionLabel(action, t)}
      description={t("logDialog.description")}
    >
      {action !== null && (
        <div className="-mx-5 -my-4 h-[min(460px,60dvh)] border-b bg-raised">
          <ActionLog key={action.id} actionId={action.id} />
        </div>
      )}
    </Dialog>
  );
}
