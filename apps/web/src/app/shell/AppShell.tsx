import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLiveServiceData } from "../../features/services/api";
import { realtime } from "../../lib/realtime";
import { ActivityTape } from "./ActivityTape";
import { CommandPalette } from "./CommandPalette";
import { TopBar } from "./TopBar";
import { useAppCommands } from "./useAppCommands";

export function AppShell() {
  const { t } = useTranslation("shell");
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const main = useRef<HTMLElement>(null);
  useAppCommands();
  useLiveServiceData();

  // The page scrolls inside <main>, so a new screen has to be brought back to the top by hand.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every change of screen
  useLayoutEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    // Deferred so that a mount immediately undone, as in Strict Mode, never opens a socket.
    const start = setTimeout(() => realtime.connect(), 0);
    return () => {
      clearTimeout(start);
      realtime.disconnect();
    };
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-sm bg-accent px-3 py-1.5 text-sm text-on-accent focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {t("skipToContent")}
      </a>
      <TopBar />
      <main
        ref={main}
        id="main"
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none"
      >
        <Outlet />
      </main>
      <ActivityTape />
      <CommandPalette />
    </div>
  );
}
