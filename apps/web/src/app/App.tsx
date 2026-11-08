import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { sessionQuery } from "../features/auth/session";
import { isApiError, setUnauthorizedHandler } from "../lib/api";
import { realtime } from "../lib/realtime";
import { Toaster, TooltipProvider } from "../ui";
import { createAppRouter } from "./router";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // Retrying is pointless once the server has given a clear answer.
        retry: (failures, error) =>
          failures < 2 && (!isApiError(error) || error.status === 0 || error.status >= 500),
      },
    },
  });
}

export function App() {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() => createAppRouter(queryClient));

  useEffect(() => {
    const endSession = () => {
      queryClient.setQueryData(sessionQuery.queryKey, { status: "signed-out" });
      void router.invalidate();
    };
    setUnauthorizedHandler(endSession);
    realtime.setSessionEndedHandler(endSession);
    return () => {
      setUnauthorizedHandler(undefined);
      realtime.setSessionEndedHandler(undefined);
    };
  }, [queryClient, router]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={350}>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
