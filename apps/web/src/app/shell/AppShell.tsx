import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { sessionQuery } from "../../features/auth/session";
import { useLiveServiceData } from "../../features/services/api";
import { usePlatformCommands } from "../../features/settings/usePlatformCommands";
import { setTwoFactorRequiredHandler } from "../../lib/api";
import { realtime } from "../../lib/realtime";
import { ActivityTape } from "./ActivityTape";
import { CommandPalette } from "./CommandPalette";
import { SimulationNotice } from "./SimulationNotice";
import { StorageBanner } from "./StorageBanner";
import { TopBar } from "./TopBar";
import { useAppCommands } from "./useAppCommands";

export function AppShell() {
  const { t } = useTranslation("shell");
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const main = useRef<HTMLElement>(null);
  useAppCommands();
  usePlatformCommands();
  useLiveServiceData();

  // The page scrolls inside <main>, so a new screen has to be brought back to the top by hand.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every change of screen
  useLayoutEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [pathname]);

  const queryClient = useQueryClient();
  const router = useRouter();
  // The owner can require two-factor sign-in while this account is in the panel without it. The
  // session then says so, and the routes send the account to turning it on.
  useEffect(() => {
    setTwoFactorRequiredHandler(() => {
      void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey }).then(() => router.invalidate());
    });
    return () => setTwoFactorRequiredHandler(undefined);
  }, [queryClient, router]);

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
        className="sr-only z-50 rounded-sm bg-accent px-3 py-2 text-sm text-on-accent focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {t("skipToContent")}
      </a>
      <TopBar />
      <StorageBanner />
      <SimulationNotice />
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
