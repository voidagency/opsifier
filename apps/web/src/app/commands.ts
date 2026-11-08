import type { LucideIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

export interface PaletteCommand {
  /** Unique across the palette. Registering the same id again replaces the earlier command. */
  id: string;
  /** Translated heading the command is listed under. */
  group: string;
  /** Translated name of the command. */
  title: string;
  /** Extra words the search should match, such as synonyms. */
  keywords?: string[];
  icon?: LucideIcon;
  /** A machine value or shortcut to show on the right. */
  hint?: string;
  run: () => void;
}

let commands: readonly PaletteCommand[] = [];
const commandListeners = new Set<() => void>();

function publishCommands(next: readonly PaletteCommand[]): void {
  commands = next;
  for (const listener of commandListeners) {
    listener();
  }
}

/**
 * Adds commands to the palette and returns the function that removes them.
 * Use `useRegisterCommands` from a component; call this directly from module scope.
 */
export function registerCommands(added: readonly PaletteCommand[]): () => void {
  const ids = new Set(added.map((command) => command.id));
  publishCommands([...commands.filter((command) => !ids.has(command.id)), ...added]);
  return () => {
    publishCommands(commands.filter((command) => !added.includes(command)));
  };
}

/** Keeps a set of commands registered while the calling component is mounted. */
export function useRegisterCommands(added: readonly PaletteCommand[]): void {
  useEffect(() => registerCommands(added), [added]);
}

export function useCommands(): readonly PaletteCommand[] {
  return useSyncExternalStore(
    (listener) => {
      commandListeners.add(listener);
      return () => commandListeners.delete(listener);
    },
    () => commands,
  );
}

let paletteOpen = false;
const paletteListeners = new Set<() => void>();

export function setPaletteOpen(open: boolean): void {
  paletteOpen = open;
  for (const listener of paletteListeners) {
    listener();
  }
}

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      paletteListeners.add(listener);
      return () => paletteListeners.delete(listener);
    },
    () => paletteOpen,
  );
}
