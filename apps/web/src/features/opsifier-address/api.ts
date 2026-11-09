import { type OpsifierAddressState, opsifierAddressState } from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";

export const addressKey = ["server", "opsifier-address"] as const;

export const addressQuery = queryOptions({
  queryKey: addressKey,
  queryFn: ({ signal }) => api.get("/server/opsifier-address", { schema: opsifierAddressState, signal }),
  refetchInterval: 30_000,
});

export const addressApi = {
  register: (): Promise<OpsifierAddressState> =>
    api.post("/server/opsifier-address/register", { schema: opsifierAddressState }),
  release: (confirm: string): Promise<OpsifierAddressState> =>
    api.delete("/server/opsifier-address", { body: { confirm }, schema: opsifierAddressState }),
};
