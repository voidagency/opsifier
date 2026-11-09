import {
  type ApplyPanelUpdateRequest,
  actionEntry,
  panelUpdateStatus,
  type RollbackPanelRequest,
} from "@opsifier/contract";
import { api } from "../../lib/api";

export const updateStatusKey = ["system", "update"] as const;

/** Only the server ever talks to the release feed: this asks the server what it last learned. */
export const updateStatusQuery = {
  queryKey: updateStatusKey,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.get("/system/update", { schema: panelUpdateStatus, signal }),
  retry: false,
};

export const checkForUpdate = () => api.post("/system/update/check", { schema: panelUpdateStatus });

export const applyUpdate = (request: ApplyPanelUpdateRequest) =>
  api.post("/system/update", { body: request, schema: actionEntry });

export const getAction = (id: string, signal?: AbortSignal) =>
  api.get(`/actions/${id}`, { schema: actionEntry, signal });

export const rollbackUpdate = (request: RollbackPanelRequest) =>
  api.post("/system/update/rollback", { body: request, schema: actionEntry });
