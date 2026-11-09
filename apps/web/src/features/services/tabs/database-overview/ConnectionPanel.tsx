import type { DatabaseAvailability, DatabaseCredentials, ServiceDetail } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Lamp, MonoValue, Pictogram, type PictogramName, Tooltip, type VisualState } from "../../../../ui";
import { databaseAvailabilityQuery } from "../../../databases/api";
import { useDatabaseParams } from "../../../databases/DatabaseLayout";
import { serviceState, serviceStateLabel } from "../../serviceState";

function ConnectionRow({
  lamp,
  pictogram,
  label,
  children,
}: {
  lamp: ReactNode;
  pictogram: PictogramName;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2.5 last:border-b-0">
      {lamp}
      <Pictogram name={pictogram} className="text-muted" />
      <span className="min-w-0 flex-1 basis-44 text-sm">{label}</span>
      <span className="min-w-0 max-w-full">{children}</span>
    </div>
  );
}

/** A process can be up with a server that refuses everyone, so this is its own lamp and its own word. */
function signInState(availability: DatabaseAvailability | undefined): {
  state: VisualState;
  word: DatabaseAvailability["signIn"] | "not-running";
} {
  if (availability === undefined) {
    return { state: "unknown", word: "unknown" };
  }
  if (availability.process === "not-running") {
    return { state: "stopped", word: "not-running" };
  }
  const state: VisualState =
    availability.signIn === "accepted" ? "running" : availability.signIn === "refused" ? "failed" : "unknown";
  return { state, word: availability.signIn };
}

/** Whether the database can be reached, from where, and at what address. */
export function ConnectionPanel({
  detail,
  credentials,
}: {
  detail: ServiceDetail;
  credentials: DatabaseCredentials;
}) {
  const { t } = useTranslation(["service-credentials", "services", "visual", "activity"]);
  const { project, engine, service } = useDatabaseParams();
  const { internal, external, rotationUnresolved } = credentials;
  const running = <Lamp state={serviceState(detail)} label={serviceStateLabel(detail, t)} />;
  const { data: availability } = useQuery(databaseAvailabilityQuery(project, service));
  const signIn = signInState(availability);

  return (
    <section className="grid gap-3">
      <h2 className="eyebrow">{t("connection.heading")}</h2>
      <div className="max-w-[900px] border-t">
        <ConnectionRow lamp={running} pictogram="node" label={t("internalGroup")}>
          <MonoValue
            value={`${internal.host}:${internal.port}`}
            copy
            copyLabel={t("copy", { field: t("internalHost") })}
            truncate
            className="text-sm"
          />
        </ConnectionRow>
        <ConnectionRow
          lamp={<Lamp state={signIn.state} label={t(`connection.signInState.${signIn.word}`)} />}
          pictogram="access"
          label={t("connection.signIn")}
        >
          <Tooltip content={availability?.detail ?? t("connection.signInHint")}>
            <span className="text-sm">{t(`connection.signInState.${signIn.word}`)}</span>
          </Tooltip>
        </ConnectionRow>
        <ConnectionRow
          lamp={external === null ? <Lamp state="stopped" label={t("connection.notExposed")} /> : running}
          pictogram="domain"
          label={t("externalGroup")}
        >
          {external === null ? (
            <Link
              to="/projects/$project/$engine/$service/expose"
              params={{ project, engine, service }}
              className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
            >
              {t("connection.notExposed")}
            </Link>
          ) : (
            <MonoValue
              value={`${external.host}:${external.port}`}
              copy
              copyLabel={t("copy", { field: t("externalHost") })}
              truncate
              className="text-sm"
            />
          )}
        </ConnectionRow>
        {rotationUnresolved && (
          <ConnectionRow
            lamp={<Lamp state="degraded" label={t("connection.passwordUnconfirmed")} />}
            pictogram="access"
            label={t("connection.passwordUnconfirmed")}
          >
            <Link
              to="/projects/$project/$engine/$service/credentials"
              params={{ project, engine, service }}
              className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
            >
              {t("rotation.check")}
            </Link>
          </ConnectionRow>
        )}
      </div>
    </section>
  );
}
