import { storageHealth } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { Lamp } from "../../ui";

/** Stands above everything while the panel can't save its state: changes are refused until it can. */
export function StorageBanner() {
  const { t } = useTranslation("shell");
  const { data } = useQuery({
    queryKey: ["system", "storage"] as const,
    queryFn: ({ signal }) => api.get("/system/storage", { schema: storageHealth, signal }),
    refetchInterval: 10_000,
  });
  if (data === undefined || data.writable) {
    return null;
  }
  return (
    <div role="alert" className="flex items-center gap-2.5 border-b px-4 py-2.5 md:px-6 lg:px-8">
      <Lamp state="failed" size="md" decorative />
      <p className="min-w-0">
        <span className="font-medium">{t("storage.title")}</span>{" "}
        <span className="text-muted">{t(`storage.${data.reason ?? "failed"}`)}</span>
      </p>
    </div>
  );
}
