import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Lamp } from "../../ui";
import { systemInfoQuery } from "./systemInfo";

/**
 * Says so on every screen when the panel runs on its simulated Docker driver, because everything
 * else about a simulated deployment looks exactly like a real one. It cannot be dismissed.
 */
export function SimulationNotice() {
  const { t } = useTranslation("shell");
  const { data } = useQuery(systemInfoQuery);

  if (data?.simulated !== true) {
    return null;
  }

  return (
    <p className="flex shrink-0 items-center gap-2.5 border-b-2 border-b-highlight bg-raised px-4 py-1.5 text-base md:px-6">
      <Lamp state="unknown" size="md" decorative />
      <span className="font-medium">{t("simulated.label")}</span>
      <span className="min-w-0 text-muted">{t("simulated.detail")}</span>
    </p>
  );
}
