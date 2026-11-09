import type { ActionEntry } from "@opsifier/contract";
import { useTranslation } from "react-i18next";
import { Dialog, Lamp, stateFromAction } from "../../ui";
import { ActionLog } from "./ActionLog";
import { actionLabel, actionPhase } from "./labels";
import { ResumeButton } from "./ResumeButton";

/** Where an action stands, or how it ended: said in the dialog, not left for the log to explain. */
function ActionSummary({ action }: { action: ActionEntry }) {
  const { t } = useTranslation("activity");
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Lamp state={stateFromAction(action.status)} label={t(`status.${action.status}`)} showLabel />
      {actionPhase(action, t)}
      {action.status === "failed" && action.error !== null && (
        <span className="text-bad">{action.error}</span>
      )}
    </span>
  );
}

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
      description={action === null ? undefined : <ActionSummary action={action} />}
      footer={action === null ? undefined : <ResumeButton action={action} />}
    >
      {action !== null && (
        <div className="-mx-5 -my-4 h-[min(460px,60dvh)] border-b bg-raised">
          <ActionLog key={action.id} actionId={action.id} />
        </div>
      )}
    </Dialog>
  );
}
