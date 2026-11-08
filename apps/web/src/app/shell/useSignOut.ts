import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { applySession, authApi } from "../../features/auth/session";
import { errorMessage } from "../../lib/forms";
import { realtime } from "../../lib/realtime";
import { toast } from "../../ui";

export function useSignOut(): () => Promise<void> {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const router = useRouter();

  return useCallback(async () => {
    let session: Awaited<ReturnType<typeof authApi.logout>>;
    try {
      session = await authApi.logout();
    } catch (error) {
      toast.error(errorMessage(error, t));
      return;
    }
    realtime.disconnect();
    // Nothing fetched for this user should outlive the session.
    queryClient.clear();
    applySession(queryClient, session);
    await router.navigate({ to: "/login", replace: true });
  }, [queryClient, router, t]);
}
