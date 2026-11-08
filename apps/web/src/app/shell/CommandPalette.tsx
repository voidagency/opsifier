import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Kbd } from "../../ui";
import { type PaletteCommand, setPaletteOpen, useCommands, usePaletteOpen } from "../commands";

function groupCommands(commands: readonly PaletteCommand[]) {
  const groups = new Map<string, PaletteCommand[]>();
  for (const command of commands) {
    groups.set(command.group, [...(groups.get(command.group) ?? []), command]);
  }
  return [...groups];
}

export function CommandPalette() {
  const { t } = useTranslation("shell");
  const open = usePaletteOpen();
  const commands = useCommands();
  const groups = useMemo(() => groupCommands(commands), [commands]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen(!open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const run = (command: PaletteCommand) => {
    setPaletteOpen(false);
    command.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={setPaletteOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-4 top-[max(1rem,12dvh)] z-50 mx-auto max-w-[560px] overflow-hidden rounded-sm border bg-raised shadow-overlay focus-visible:outline-none data-[state=closed]:animate-rise-out data-[state=open]:animate-rise-in"
        >
          <Dialog.Title className="sr-only">{t("palette.title")}</Dialog.Title>
          <Command loop label={t("palette.title")}>
            <div className="flex items-center gap-2.5 border-b px-3.5">
              <Search aria-hidden="true" className="size-4 shrink-0 text-muted" />
              <Command.Input
                placeholder={t("palette.placeholder")}
                className="h-11 min-w-0 flex-1 bg-transparent text-base placeholder:text-muted"
              />
              <span className="hidden sm:inline-flex">
                <Kbd>esc</Kbd>
              </span>
            </div>
            <Command.List className="max-h-[min(380px,52dvh)] overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1">
              <Command.Empty className="px-2 py-8 text-center text-sm text-muted">
                {t("palette.empty")}
              </Command.Empty>
              {groups.map(([group, items]) => (
                <Command.Group key={group} heading={group}>
                  {items.map((command) => {
                    const Icon = command.icon;
                    return (
                      <Command.Item
                        key={command.id}
                        value={command.id}
                        keywords={[command.title, ...(command.keywords ?? [])]}
                        onSelect={() => run(command)}
                        className="relative flex h-9 cursor-default select-none items-center gap-2.5 rounded-sm pr-2 pl-2.5 text-sm before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:bg-accent before:opacity-0 data-[selected=true]:bg-wash data-[selected=true]:before:opacity-100"
                      >
                        {Icon && <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />}
                        <span className="min-w-0 flex-1 truncate">{command.title}</span>
                        {command.hint && <span className="font-mono text-xs text-muted">{command.hint}</span>}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ))}
            </Command.List>
            <footer className="flex items-center gap-4 border-t px-3.5 py-2 text-xs text-muted">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                {t("palette.move")}
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd>
                {t("palette.select")}
              </span>
            </footer>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
