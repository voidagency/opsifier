import { type CallerIdentity, type CallerProjectRole, callerIdentity } from "@opsifier/contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useCurrentUser } from "./session";

/**
 * What this session may do, as the server judges it now. It only decides what the page offers: every
 * request is still checked when it is made. A role taken away ends the session, so a minute is enough.
 */
export const identityQuery = queryOptions({
  queryKey: ["auth", "identity"] as const,
  queryFn: ({ signal }) => api.get<CallerIdentity>("/auth/identity", { schema: callerIdentity, signal }),
  staleTime: 60_000,
});

/**
 * The signed-in person's role in one project: `admin` for an administrator, who reaches every project
 * as one. Null while it is not known yet, and for a project out of reach.
 */
export function useProjectRole(project: string): CallerProjectRole | null {
  const user = useCurrentUser();
  const administrator = user?.role === "admin";
  const { data } = useQuery({ ...identityQuery, enabled: user !== null && !administrator });
  if (administrator) {
    return "admin";
  }
  return data?.projects?.find((entry) => entry.name === project)?.role ?? null;
}
