import { systemInfo } from "@opsifier/contract";
import { api } from "../../lib/api";

export const systemInfoQuery = {
  queryKey: ["system", "info"] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => api.get("/system/info", { schema: systemInfo, signal }),
  staleTime: 5 * 60_000,
};
