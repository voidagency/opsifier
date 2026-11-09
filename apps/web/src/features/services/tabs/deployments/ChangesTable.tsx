import type { ConfigChange, ConfigChangeArea } from "@opsifier/contract";
import { useTranslation } from "react-i18next";
import {
  Lamp,
  MonoValue,
  Pictogram,
  type PictogramName,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "../../../../ui";

const areaPictograms: Readonly<Record<ConfigChangeArea, PictogramName>> = {
  image: "image",
  source: "git",
  build: "dockerfile",
  environment: "environment",
  command: "console",
  resources: "cpu",
  replicas: "node",
  volumes: "volume",
  files: "upload",
  ports: "port",
  compose: "compose",
  advanced: "settings",
};

/** Variables and file contents are named and never quoted, so an empty side is told apart from a hidden one. */
function SideValue({ value, present }: { value: string | null; present: boolean }) {
  const { t } = useTranslation("service-deployments");
  if (value !== null) {
    return <MonoValue value={value} className="break-all text-sm" />;
  }
  return <span className="text-muted">{present ? t("changes.hidden") : t("changes.none")}</span>;
}

export interface ChangesTableProps {
  changes: readonly ConfigChange[];
  /** What the two columns are, such as "Running now" and "Saved". */
  beforeLabel: string;
  afterLabel: string;
}

/** Differences between two configurations, one per row, with a lamp saying how each one moves. */
export function ChangesTable({ changes, beforeLabel, afterLabel }: ChangesTableProps) {
  const { t } = useTranslation("service-deployments");
  return (
    <Table>
      <THead>
        <TR>
          <TH>{t("changes.what")}</TH>
          <TH>{beforeLabel}</TH>
          <TH>{afterLabel}</TH>
        </TR>
      </THead>
      <TBody>
        {changes.map((change) => (
          <TR key={`${change.area}/${change.name}`}>
            <TD>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Lamp state="progress" still label={t(`changes.kind.${change.kind}`)} />
                <Pictogram name={areaPictograms[change.area]} className="text-muted" />
                <span>{t(`changes.areas.${change.area}`)}</span>
                {change.name !== "" && (
                  <MonoValue value={t(`changes.names.${change.name}`, change.name)} className="text-sm" />
                )}
              </span>
            </TD>
            <TD>
              <SideValue value={change.before} present={change.kind !== "added"} />
            </TD>
            <TD>
              <SideValue value={change.after} present={change.kind !== "removed"} />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
