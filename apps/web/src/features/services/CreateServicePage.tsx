import { type DatabaseEngine, isDatabaseEngine } from "@opsifier/contract";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger, useDocumentTitle } from "../../ui";
import { CreateBoxDialog } from "../box/CreateBoxDialog";
import { CreateComposeDialog } from "../compose/CreateComposeDialog";
import { CreateDatabaseDialog } from "../databases/CreateDatabaseDialog";
import { CustomTab } from "../templates/CustomTab";
import { TemplatesTab } from "../templates/TemplatesTab";
import { CreateServiceDialog } from "./CreateServiceDialog";

const route = getRouteApi("/app/projects/$project/create");

export type CreateServiceTab = "services" | "templates" | "custom";
export const createServiceTabs: readonly CreateServiceTab[] = ["services", "templates", "custom"];

export const serviceTypeOptions = [
  "app",
  "mysql",
  "mariadb",
  "postgres",
  "mongo",
  "redis",
  "box",
  "compose",
  "wordpress",
] as const;

function ServiceTypes({
  onChooseApp,
  onChooseBox,
  onChooseCompose,
  onChooseDatabase,
}: {
  onChooseApp: () => void;
  onChooseBox: () => void;
  onChooseCompose: () => void;
  onChooseDatabase: (engine: DatabaseEngine) => void;
}) {
  const { t } = useTranslation("services");
  return (
    <ul className="grid max-w-[1130px] grid-cols-1 overflow-hidden rounded-sm border-t border-l sm:grid-cols-2 lg:grid-cols-3">
      {serviceTypeOptions.map((type) => {
        const choose =
          type === "app"
            ? onChooseApp
            : type === "compose"
              ? onChooseCompose
              : type === "box"
                ? onChooseBox
                : isDatabaseEngine(type)
                  ? () => onChooseDatabase(type)
                  : null;
        return (
          <li key={type} className="border-r border-b">
            {choose !== null ? (
              <button
                type="button"
                onClick={choose}
                className="group grid h-full w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 text-left hover:bg-wash"
              >
                <span>
                  <span className="block text-sm font-medium">{t(`create.types.${type}.name`)}</span>
                  <span className="block text-xs text-muted">{t(`create.types.${type}.hint`)}</span>
                </span>
                <ArrowRight aria-hidden="true" className="size-4 text-muted group-hover:text-ink" />
              </button>
            ) : (
              <div className="grid h-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3">
                <span>
                  <span className="block text-sm text-muted">{t(`create.types.${type}.name`)}</span>
                  <span className="block text-xs text-muted">{t(`create.types.${type}.hint`)}</span>
                </span>
                <Badge tone="off">{t("create.soon")}</Badge>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Picks what to create in a project. The tab lives in the URL, so it survives a reload. */
export function CreateServicePage() {
  const { t } = useTranslation("services");
  const { project } = route.useParams();
  const tab = route.useSearch({ select: (search) => search.tab ?? "services" });
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [creatingCompose, setCreatingCompose] = useState(false);
  const [creatingBox, setCreatingBox] = useState(false);
  const [creatingDatabase, setCreatingDatabase] = useState<DatabaseEngine | null>(null);
  useDocumentTitle(t("create.pageTitle"));

  return (
    <Tabs
      value={tab}
      onValueChange={(next) =>
        navigate({ to: ".", search: { tab: next as CreateServiceTab }, replace: true })
      }
    >
      <PageHeader title={t("create.pageTitle")} description={t("create.pageDescription", { project })}>
        <TabsList className="border-b-0">
          {createServiceTabs.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`create.tabs.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </PageHeader>
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <TabsContent value="services">
          <ServiceTypes
            onChooseApp={() => setCreating(true)}
            onChooseCompose={() => setCreatingCompose(true)}
            onChooseBox={() => setCreatingBox(true)}
            onChooseDatabase={setCreatingDatabase}
          />
        </TabsContent>
        <TabsContent value="templates">
          <TemplatesTab project={project} />
        </TabsContent>
        <TabsContent value="custom">
          <CustomTab project={project} />
        </TabsContent>
      </div>
      <CreateServiceDialog project={project} open={creating} onOpenChange={setCreating} />
      <CreateComposeDialog project={project} open={creatingCompose} onOpenChange={setCreatingCompose} />
      <CreateBoxDialog project={project} open={creatingBox} onOpenChange={setCreatingBox} />
      {creatingDatabase !== null && (
        <CreateDatabaseDialog
          project={project}
          engine={creatingDatabase}
          open
          onOpenChange={(open) => setCreatingDatabase(open ? creatingDatabase : null)}
        />
      )}
    </Tabs>
  );
}
