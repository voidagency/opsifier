import { type ActionEntry, deployActionType } from "@opsifier/contract";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { Button, Tooltip, toast } from "../../ui";
import { servicesApi } from "../services/api";

const RESUMABLE: ReadonlySet<ActionEntry["status"]> = new Set(["failed", "cancelled"]);

/**
 * Starts a failed deployment again. Nothing but a press of this button ever sends the deploy again:
 * coming back to the page or reconnecting only shows what the task did.
 */
export function ResumeButton({ action, compact = false }: { action: ActionEntry; compact?: boolean }) {
  const { t } = useTranslation(["activity", "common"]);
  const { projectName, serviceName } = action;

  if (
    action.type !== deployActionType ||
    !RESUMABLE.has(action.status) ||
    projectName === null ||
    serviceName === null
  ) {
    return null;
  }

  const resume = async () => {
    try {
      await servicesApi.deploy(projectName, serviceName);
      toast.success(t("resumed"));
    } catch (error) {
      toast.error(errorMessage(error, t));
    }
  };

  return compact ? (
    <Tooltip content={t("resume")}>
      <Button size="icon-sm" variant="ghost" aria-label={t("resume")} onClick={resume}>
        <RotateCcw aria-hidden="true" className="size-3.5" />
      </Button>
    </Tooltip>
  ) : (
    <Button icon={<RotateCcw aria-hidden="true" className="size-4" />} onClick={resume}>
      {t("resume")}
    </Button>
  );
}
