import { ScrollText, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Tooltip } from "../../ui";
import { useProjectRole } from "../auth/identity";
import { ConsoleDialog } from "./ConsoleDialog";
import { LogsFullscreen } from "./LogsPanel";

interface RuntimeButtonProps {
  project: string;
  service: string;
}

/** Opens the live logs of a service, of any type, in the whole window. */
export function LogsButton({ project, service }: RuntimeButtonProps) {
  const { t } = useTranslation("service-runtime");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content={t("logs.open")}>
        <Button
          size="icon"
          aria-label={t("logs.open")}
          onClick={() => setOpen(true)}
          data-tour="service-logs"
        >
          <ScrollText aria-hidden="true" className="size-4" />
        </Button>
      </Tooltip>
      {open && <LogsFullscreen project={project} service={service} open onOpenChange={setOpen} />}
    </>
  );
}

interface ConsoleButtonProps extends RuntimeButtonProps {
  /** Whether a task is running that a console could open in. */
  running: boolean;
}

/**
 * Opens a console in a task of a service, of any type. For administrators and the project's maintainers:
 * the server enforces it, and keeps a maintainer out of a service that reaches the server.
 */
export function ConsoleButton({ project, service, running }: ConsoleButtonProps) {
  const { t } = useTranslation("service-runtime");
  const role = useProjectRole(project);
  const [open, setOpen] = useState(false);
  const allowed = role === "admin" || role === "maintainer";
  const hint = !allowed ? t("console.adminOnly") : running ? t("console.open") : t("console.notRunning");

  return (
    <>
      <Button
        size="icon"
        aria-label={t("console.open")}
        tooltip={hint}
        disabledReason={!allowed ? t("console.adminOnly") : running ? undefined : t("console.notRunning")}
        onClick={() => setOpen(true)}
      >
        <SquareTerminal aria-hidden="true" className="size-4" />
      </Button>
      {open && <ConsoleDialog project={project} service={service} open onOpenChange={setOpen} />}
    </>
  );
}
