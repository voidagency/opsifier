import type { ConsoleProgram } from "@opsifier/contract";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Power, X } from "lucide-react";
import { lazy, type RefObject, Suspense, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { Button, FormBanner, Select, Skeleton, useReturnFocus } from "../../ui";
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
  const returnFocus = useReturnFocus(open);
  const sessionOpen = useRef(false);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-scrim data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <RadixDialog.Content
          aria-describedby={undefined}
          // During a session Escape belongs to the program in the terminal.
          onEscapeKeyDown={(event) => {
            if (sessionOpen.current) {
              event.preventDefault();
            }
          }}
          // A stray click must not end a session.
          onInteractOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={returnFocus}
          className="fixed inset-x-4 inset-y-4 z-50 mx-auto flex max-w-[1380px] flex-col rounded-sm border bg-raised shadow-overlay focus-visible:outline-none data-[state=closed]:animate-rise-out data-[state=open]:animate-rise-in md:inset-y-[6dvh]"
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
          {open && <ConsoleBody project={project} service={service} sessionOpen={sessionOpen} />}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function ConsoleBody({
  project,
  service,
  sessionOpen,
}: {
  project: string;
  service: string;
  sessionOpen: RefObject<boolean>;
}) {
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
  const programs = data.tasks.find((item) => item.id === task)?.programs ?? [];
  const connected = session !== null && status !== "ended";
  sessionOpen.current = connected;

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
          <div className="w-full max-w-[530px] min-w-[280px] flex-1">
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
          {programs.map((program) => (
            <Button
              key={program}
              disabledReason={
                connected ? t("console.sessionOpen") : task === undefined ? t("console.noTasks") : undefined
              }
              variant={isCurrent({ program }) && connected ? "primary" : "secondary"}
              onClick={() => start({ program })}
            >
              {PROGRAM_LABELS[program]}
            </Button>
          ))}
          {data.scripts.map((script) => (
            <Button
              key={script}
              disabledReason={
                connected
                  ? t("console.sessionOpen")
                  : task === undefined
                    ? t("console.noTasks")
                    : programs.includes("sh")
                      ? undefined
                      : t("console.noShell")
              }
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
          <p className="text-sm text-muted">
            {data.tasks.length === 0 ? null : t(programs.length === 0 ? "console.noShell" : "console.choose")}
          </p>
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
                fallback: (opened) => t("console.fallback", { opened }),
              }}
              onStatus={setStatus}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
