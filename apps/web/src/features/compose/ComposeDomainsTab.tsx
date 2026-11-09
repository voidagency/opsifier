import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FormBanner } from "../../ui";
import { domainsQuery, useServiceParams } from "../services/api";
import { DomainsTab } from "../services/tabs/domains/DomainsTab";
import { composeQuery } from "./api";

/** The ordinary Domains tab, with one more question: which child of the stack does each domain reach? */
export function ComposeDomainsTab() {
  const { t } = useTranslation("compose");
  const { project, service } = useServiceParams();
  const { data: domains } = useQuery(domainsQuery(project, service));
  const { data: compose } = useQuery(composeQuery(project, service));
  const needsChild = domains?.domains.some((domain) => domain.composeService === "") ?? false;

  return (
    <div className="grid">
      {needsChild && (
        <div className="px-4 pt-6 md:px-6 lg:px-8">
          <FormBanner tone="warning" className="max-w-[1100px]">
            {t("domains.chooseChild")}
          </FormBanner>
        </div>
      )}
      <DomainsTab composeServices={compose?.services ?? []} />
    </div>
  );
}
