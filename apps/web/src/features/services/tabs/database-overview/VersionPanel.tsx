import type { DatabaseDetail } from "@opsifier/contract";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Lamp, MonoValue, Pictogram, Tooltip, type VisualState } from "../../../../ui";

/** The hash part of an ID or digest, short enough for a row. The whole of it is in the tooltip. */
const shortImageId = (value: string) => value.replace(/^.*sha256:/, "sha256:").slice(0, 19);

function VersionRow({
  state,
  stateLabel,
  label,
  hint,
  children,
}: {
  state: VisualState;
  stateLabel: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const row = (
    <span className="min-w-0 flex-1 basis-44 text-sm">
      {hint === undefined ? (
        label
      ) : (
        <Tooltip content={hint}>
          <button type="button" className="underline decoration-dotted underline-offset-2">
            {label}
          </button>
        </Tooltip>
      )}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2.5 last:border-b-0">
      <Lamp state={state} still label={stateLabel} />
      <Pictogram name="image" className="text-muted" />
      {row}
      <span className="min-w-0 max-w-full">{children}</span>
    </div>
  );
}

/**
 * Three things that are easy to confuse and kept apart on purpose: what the catalogue would give a
 * new database today, what this one is set to, and the exact image it really runs.
 */
export function VersionPanel({ versions }: { versions: DatabaseDetail["versions"] }) {
  const { t } = useTranslation("service-credentials");
  const { proposed, configured, running } = versions;
  const settled = running !== null && running.image === configured;

  return (
    <section className="grid gap-3">
      <h2 className="eyebrow">{t("versions.heading")}</h2>
      <div className="max-w-[900px] border-t">
        <VersionRow
          state={running === null ? "stopped" : "running"}
          stateLabel={running === null ? t("versions.runningNone") : t("versions.running")}
          label={t("versions.running")}
        >
          {running === null ? (
            <span className="text-sm text-muted">{t("versions.runningNone")}</span>
          ) : (
            <span className="grid justify-items-end">
              <MonoValue value={running.image} className="text-sm" />
              <span title={running.digest ?? running.imageId} className="font-mono text-xs text-muted">
                {shortImageId(running.digest ?? running.imageId)}
              </span>
            </span>
          )}
        </VersionRow>
        <VersionRow
          state={settled ? "running" : "progress"}
          stateLabel={settled ? t("versions.same") : t("versions.waiting")}
          label={t("versions.configured")}
        >
          <MonoValue value={configured} className="text-sm" />
        </VersionRow>
        <VersionRow
          state="stopped"
          stateLabel={t("versions.proposed")}
          label={t("versions.proposed")}
          hint={t("versions.proposedHint")}
        >
          <MonoValue value={proposed} className="text-sm" />
        </VersionRow>
      </div>
    </section>
  );
}
