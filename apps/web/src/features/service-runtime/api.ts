import { consoleInfo, type LogSearchQuery, logSearchResult } from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";

const base = (project: string, service: string) => `/projects/${project}/services/${service}`;

/** What the console can open. Asked for each time the dialog opens, since tasks come and go. */
export const consoleInfoQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: ["service-runtime", project, service, "console"] as const,
    queryFn: ({ signal }) => api.get(`${base(project, service)}/console`, { schema: consoleInfo, signal }),
    staleTime: 0,
    gcTime: 0,
  });

export function searchLogs(
  project: string,
  service: string,
  query: Partial<LogSearchQuery>,
  signal?: AbortSignal,
) {
  return api.get(`${base(project, service)}/logs/search`, { query, schema: logSearchResult, signal });
}
