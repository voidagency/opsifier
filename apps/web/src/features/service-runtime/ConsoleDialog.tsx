import type { ConsoleProgram } from "@opsifier/contract";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Power, X } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { Button, FormBanner, Select, Skeleton } from "../../ui";
import { consoleInfoQuery } from "./api";
import type { TerminalPaneProps, TerminalStatus } from "./TerminalPane";

const TerminalPane = lazy(() => import("./TerminalPane"));

const PROGRAM_LABELS: Record<ConsoleProgram, string> = { sh: "Sh", bash: "Bash" };

type Target = TerminalPaneProps["target"];

interface ConsoleDialogProps {
  project: string;
  service: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The body lives only while the dialog is open, which is what ends a session when it closes. */
export function ConsoleDialog({ project, service, open, onOpenChange }: ConsoleDialogProps) {
  const { t } = useTranslation();
  const { t: tRuntime } = useTranslation("service-runtime");
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-scrim data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <RadixDialog.Content
          aria-describedby={undefined}
          // Terminal programs use Escape, and a stray click must not end a session.
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed inset-x-4 inset-y-4 z-50 mx-auto flex max-w-[1100px] flex-col rounded-sm border bg-raised shadow-overlay focus-visible:outline-none data-[state=closed]:animate-rise-out data-[state=open]:animate-rise-in md:inset-y-[6dvh]"
        >
          <header className="flex items-center gap-3 border-b py-3 pr-3 pl-5">
            <RadixDialog.Title className="min-w-0 flex-1 truncate text-md font-medium">
              {tRuntime("console.title", { service: `${project}/${service}` })}
            </RadixDialog.Title>
            <RadixDialog.Close
              aria-label={t("actions.close")}
              className="flex size-7 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
            >
              <X aria-hidden="true" className="size-4" />
            </RadixDialog.Close>
          </header>
          {open && <ConsoleBody project={project} service={service} />}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function ConsoleBody({ project, service }: { project: string; service: string }) {
  const { t } = useTranslation(["service-runtime", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery(consoleInfoQuery(project, service));
  const [chosenTask, setChosenTask] = useState<string | undefined>();
  const [session, setSession] = useState<{ id: number; task: string; target: Target } | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");

  if (isPending) {
    return (
      <div className="p-5">
        <Skeleton className="h-9" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="grid justify-items-start gap-3 p-5">
        <FormBanner>{errorMessage(error, t)}</FormBanner>
        <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
      </div>
    );
  }

  const task = chosenTask ?? data.tasks[0]?.id;
  const connected = session !== null && status !== "ended";

  const start = (target: Target) => {
    if (task !== undefined) {
      setStatus("connecting");
      setSession((current) => ({ id: (current?.id ?? 0) + 1, task, target }));
    }
  };

  const isCurrent = (target: Target) =>
    session !== null && JSON.stringify(session.target) === JSON.stringify(target);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
        {data.tasks.length === 0 ? (
          <p className="text-sm text-muted">{t("console.noTasks")}</p>
        ) : (
          <div className="w-full max-w-[420px] min-w-[220px] flex-1">
            <Select
              aria-label={t("console.task")}
              value={task}
              onValueChange={setChosenTask}
              disabled={connected}
              options={data.tasks.map((item) => ({ value: item.id, label: item.name }))}
              className="font-mono text-xs"
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {data.programs.map((program) => (
            <Button
              key={program}
              disabled={task === undefined || connected}
              variant={isCurrent({ program }) && connected ? "primary" : "secondary"}
              onClick={() => start({ program })}
            >
              {PROGRAM_LABELS[program]}
            </Button>
          ))}
          {data.scripts.map((script) => (
            <Button
              key={script}
              disabled={task === undefined || connected}
              variant={isCurrent({ script }) && connected ? "primary" : "secondary"}
              onClick={() => start({ script })}
            >
              {script}
            </Button>
          ))}
        </div>
        {connected && (
          <Button
            variant="ghost"
            className="ml-auto"
            icon={<Power aria-hidden="true" className="size-4" />}
            onClick={() => setSession(null)}
          >
            {t("console.disconnect")}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 bg-raised p-3">
        {session === null ? (
          <p className="text-sm text-muted">{data.tasks.length === 0 ? null : t("console.choose")}</p>
        ) : (
          <Suspense fallback={<Skeleton className="h-full" />}>
            <TerminalPane
              key={session.id}
              project={project}
              service={service}
              task={session.task}
              target={session.target}
              messages={{
                ended: (code) => (code === null ? t("console.ended") : t("console.endedWithCode", { code })),
                lost: t("console.lost"),
                refused: t("console.refused"),
              }}
              onStatus={setStatus}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
