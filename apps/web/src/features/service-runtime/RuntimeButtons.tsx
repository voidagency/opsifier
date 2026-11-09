import { ScrollText, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Tooltip } from "../../ui";
import { useCurrentUser } from "../auth/session";
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
        <Button size="icon" aria-label={t("logs.open")} onClick={() => setOpen(true)}>
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

/** Opens a console in a task of a service, of any type. Administrators only: the server enforces it. */
export function ConsoleButton({ project, service, running }: ConsoleButtonProps) {
  const { t } = useTranslation("service-runtime");
  const user = useCurrentUser();
  const [open, setOpen] = useState(false);
  const allowed = user?.role === "admin";
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
