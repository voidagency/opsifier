import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { ErrorState, Skeleton, useDocumentTitle } from "../../ui";
import { serviceQuery, useServiceParams } from "../services/api";
import { RenameDialog } from "../services/RenameDialog";
import { ServiceHeader, TabPictogram, tabLinkClass } from "../services/ServiceHeader";
import { ServiceToolbar } from "../services/ServiceLayout";
import { boxTabs } from "./tabs";

function BoxTabNav() {
  const { t } = useTranslation("box");
  const { project, service } = useServiceParams();
  return (
    <nav
      aria-label={t("tabs.label")}
      className="-mb-px flex gap-x-5 overflow-x-auto [scrollbar-width:none] md:flex-wrap md:overflow-visible"
    >
      {boxTabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          params={{ project, service }}
          activeOptions={{ exact: tab.key === "overview", includeHash: false, includeSearch: false }}
          className={tabLinkClass}
        >
          <TabPictogram tab={tab.key} />
          {t(`tabs.${tab.key}`)}
        </Link>
      ))}
    </nav>
  );
}

/** The frame of every box tab. It is a service like an App, so it has the same identity and toolbar. */
export function BoxLayout() {
  const { t } = useTranslation("box");
  const { project, service } = useServiceParams();
  const {
    data: detail,
    error,
    refetch,
  } = useQuery({ ...serviceQuery(project, service), refetchInterval: 3000 });
  const [renaming, setRenaming] = useState(false);
  useDocumentTitle(service);

  if (detail === undefined) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        {error ? (
          <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
        ) : (
          <Skeleton className="h-16" />
        )}
      </div>
    );
  }

  return (
    <>
      <ServiceHeader
        project={project}
        service={service}
        detail={detail}
        toolbar={<ServiceToolbar detail={detail} />}
        tabs={<BoxTabNav />}
        onRename={() => setRenaming(true)}
      />
      <Outlet />
      <RenameDialog project={project} service={service} open={renaming} onOpenChange={setRenaming} />
    </>
  );
}
