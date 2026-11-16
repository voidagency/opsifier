import type { CallerIdentity, StudioOverview } from "@opsifier/contract";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { identityQuery } from "../auth/identity";
import { sessionQuery, useCurrentUser } from "../auth/session";
import { studioOverviewQuery } from "./api";

/**
 * A member who reaches no project of the panel and has projects of the Studio shared with them, as a
 * designer does: the Studio is all there is for them, so the panel shows them nothing else and opens
 * on it.
 */
export function isStudioOnly(
  identity: CallerIdentity | undefined,
  overview: StudioOverview | undefined,
): boolean {
  const reachesNoProject = identity?.projects?.length === 0 && identity.user.role !== "admin";
  return reachesNoProject && overview?.enabled === true && overview.apps.length > 0;
}

/**
 * Whether the signed-in account only has the Studio. Null while that is not known yet, so that the
 * panel's menu does not show to a designer for a moment; false once either answer failed.
 */
export function useStudioOnly(): boolean | null {
  const user = useCurrentUser();
  const member = user !== null && user.role !== "admin";
  const identity = useQuery({ ...identityQuery, enabled: member });
  const overview = useQuery({ ...studioOverviewQuery, enabled: member });
  if (!member || identity.isError || overview.isError) {
    return false;
  }
  if (identity.data === undefined || overview.data === undefined) {
    return null;
  }
  return isStudioOnly(identity.data, overview.data);
}

/** The same, for a route deciding where to send someone before it shows anything. */
export async function isStudioOnlyAccount(queryClient: QueryClient): Promise<boolean> {
  const session = await queryClient.ensureQueryData(sessionQuery);
  if (session.status !== "signed-in" || session.user.role === "admin") {
    return false;
  }
  try {
    const [identity, overview] = await Promise.all([
      queryClient.ensureQueryData(identityQuery),
      queryClient.ensureQueryData(studioOverviewQuery),
    ]);
    return isStudioOnly(identity, overview);
  } catch {
    // Unknown is not Studio-only: the overview opens as it always did.
    return false;
  }
}
