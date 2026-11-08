import { actionDetail, actionEntry, actionPage } from "@opsifier/contract";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";

export const activityKey = ["actions", "activity"] as const;

const PAGE_SIZE = 15;

/** Newest first, a page at a time. */
export const activityQuery = infiniteQueryOptions({
  queryKey: activityKey,
  queryFn: ({ pageParam, signal }) =>
    api.get("/actions", { query: { limit: PAGE_SIZE, cursor: pageParam }, schema: actionPage, signal }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (page) => page.nextCursor ?? undefined,
  staleTime: 0,
});

/** Always fetched afresh: a cached log would miss the lines written since it was last opened. */
export const actionDetailQuery = (id: string) =>
  queryOptions({
    queryKey: ["actions", "detail", id] as const,
    queryFn: ({ signal }) => api.get(`/actions/${id}`, { schema: actionDetail, signal }),
    staleTime: 0,
    gcTime: 0,
  });

export const actionsApi = {
  cancel: (id: string) => api.post(`/actions/${id}/cancel`, { schema: actionEntry }),
};
