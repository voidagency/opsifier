import type { DatabaseCredentials, DatabaseSecretName } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Pencil } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "../../../../lib/clipboard";
import { errorMessage } from "../../../../lib/forms";
import {
  Button,
  CopyButton,
  ErrorState,
  FormBanner,
  Lamp,
  MonoValue,
  Skeleton,
  Tooltip,
  toast,
} from "../../../../ui";
import { credentialsQuery, databasesApi } from "../../../databases/api";
import { useDatabaseParams } from "../../../databases/DatabaseLayout";
import { useActionFollower } from "../../ActionFollower";
import { serviceKey, serviceQuery } from "../../api";
import { serviceState, serviceStateLabel } from "../../serviceState";
import { ChangePasswordDialog } from "./ChangePasswordDialog";

/** A masked secret: revealing it, and copying it, both go through the audited reveal endpoint. */
function SecretRow({
  label,
  masked,
  secret,
  project,
  service,
}: {
  label: string;
  masked: string;
  secret: DatabaseSecretName;
  project: string;
  service: string;
}) {
  const { t } = useTranslation(["service-credentials", "common"]);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const fetchSecret = async (): Promise<string | null> => {
    setPending(true);
    try {
      return (await databasesApi.reveal(project, service, secret)).value;
    } catch (error) {
      toast.error(t("revealFailed"), errorMessage(error, t));
      return null;
    } finally {
      setPending(false);
    }
  };

  const toggle = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    setRevealed(await fetchSecret());
  };

  const copy = async () => {
    const value = revealed ?? (await fetchSecret());
    if (value !== null && !(await copyText(value))) {
      toast.error(t("common:copy.failed"));
    }
  };

  return (
    <Row label={label}>
      <span className="min-w-0 break-all font-mono text-sm">{revealed ?? masked}</span>
      <span className="flex shrink-0 items-center gap-0.5">
        <Tooltip content={revealed === null ? t("reveal") : t("hide")}>
          <button
            type="button"
            onClick={toggle}
            disabled={pending}
            aria-label={revealed === null ? t("reveal") : t("hide")}
            aria-pressed={revealed !== null}
            className="inline-flex size-6 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink disabled:opacity-45"
          >
            {revealed === null ? (
              <Eye aria-hidden="true" className="size-3.5" />
            ) : (
              <EyeOff aria-hidden="true" className="size-3.5" />
            )}
          </button>
        </Tooltip>
        <CopySecretButton copy={copy} label={t("copy", { field: label })} />
      </span>
    </Row>
  );
}

function CopySecretButton({ copy, label }: { copy: () => Promise<void>; label: string }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label}
        className="inline-flex size-6 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
      >
        <CopyIcon />
      </button>
    </Tooltip>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-1 border-b py-2.5 last:border-b-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center">
      <dt className="eyebrow">{label}</dt>
      <dd className="flex min-w-0 items-center justify-between gap-3">{children}</dd>
    </div>
  );
}

function Group({ title, lamp, children }: { title: string; lamp?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="eyebrow flex items-center gap-2">
        {lamp}
        {title}
      </h2>
      <dl className="max-w-[1030px] border-t">{children}</dl>
    </section>
  );
}

const copyableValue = (value: string, label: string) => (
  <span className="flex min-w-0 items-center gap-1">
    <MonoValue value={value} truncate />
    <CopyButton value={value} label={label} />
  </span>
);

function CredentialsContent({ credentials }: { credentials: DatabaseCredentials }) {
  const { t } = useTranslation(["service-credentials", "common", "services", "visual", "activity"]);
  const { project, service } = useDatabaseParams();
  const { data: detail } = useQuery(serviceQuery(project, service));
  const lamp =
    detail === undefined ? undefined : (
      <Lamp state={serviceState(detail)} label={serviceStateLabel(detail, t)} />
    );
  const [editing, setEditing] = useState(false);
  // Bumped after a password change, so nothing keeps showing the old secret.
  const [generation, setGeneration] = useState(0);
  const { user, databaseName, internal, external } = credentials;
  const secretProps = { project, service };

  return (
    <div className="grid gap-8 px-4 py-6 md:px-6 lg:px-8">
      {credentials.rotationUnresolved && <RotationBanner />}

      <Group title={t("internalGroup")} lamp={lamp}>
        <Row label={t("user")}>{copyableValue(user, t("copy", { field: t("user") }))}</Row>
        <SecretRow
          key={`password-${generation}`}
          {...secretProps}
          label={t("password")}
          masked="••••••••"
          secret="password"
        />
        {credentials.hasRootPassword && (
          <SecretRow
            key={`root-${generation}`}
            {...secretProps}
            label={t("rootPassword")}
            masked="••••••••"
            secret="rootPassword"
          />
        )}
        {databaseName !== null && (
          <Row label={t("databaseName")}>
            {copyableValue(databaseName, t("copy", { field: t("databaseName") }))}
          </Row>
        )}
        <Row label={t("internalHost")}>
          {copyableValue(internal.host, t("copy", { field: t("internalHost") }))}
        </Row>
        <Row label={t("internalPort")}>
          {copyableValue(String(internal.port), t("copy", { field: t("internalPort") }))}
        </Row>
        <SecretRow
          {...secretProps}
          label={t("internalUrl")}
          masked={internal.maskedUrl}
          secret="internalUrl"
        />
      </Group>

      {external !== null && (
        <Group title={t("externalGroup")} lamp={lamp}>
          <Row label={t("externalHost")}>
            {copyableValue(external.host, t("copy", { field: t("externalHost") }))}
          </Row>
          <Row label={t("externalPort")}>
            {copyableValue(String(external.port), t("copy", { field: t("externalPort") }))}
          </Row>
          <SecretRow
            {...secretProps}
            label={t("externalUrl")}
            masked={external.maskedUrl}
            secret="externalUrl"
          />
        </Group>
      )}

      <div>
        <Button icon={<Pencil aria-hidden="true" className="size-4" />} onClick={() => setEditing(true)}>
          {t("change.open")}
        </Button>
      </div>
      <ChangePasswordDialog
        project={project}
        service={service}
        hasRootPassword={credentials.hasRootPassword}
        open={editing}
        onOpenChange={setEditing}
        onChanged={() => setGeneration((current) => current + 1)}
      />
    </div>
  );
}

function RotationBanner() {
  const { t } = useTranslation(["service-credentials", "common"]);
  const { project, service } = useDatabaseParams();
  const queryClient = useQueryClient();
  const follow = useActionFollower();
  const [pending, setPending] = useState(false);

  const check = async () => {
    setPending(true);
    try {
      const action = await databasesApi.checkPassword(project, service);
      follow(action.id, {
        success: () => toast.success(t("rotation.resolved")),
        failure: (ended) => toast.error(t("rotation.failed"), ended.error ?? undefined),
      });
      await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
    } catch (error) {
      toast.error(t("rotation.failed"), errorMessage(error, t));
    } finally {
      setPending(false);
    }
  };

  return (
    <FormBanner tone="warning" title={t("rotation.title")}>
      <div className="grid justify-items-start gap-2">
        <p>{t("rotation.description")}</p>
        <Button size="sm" pending={pending} onClick={check}>
          {t("rotation.check")}
        </Button>
      </div>
    </FormBanner>
  );
}

/** Who connects, and how. Every secret stays masked until someone asks for it. */
export function CredentialsTab() {
  const { t } = useTranslation(["service-credentials", "common"]);
  const { project, service } = useDatabaseParams();
  const { data, error, refetch, isPending } = useQuery({
    ...credentialsQuery(project, service),
    refetchInterval: 5000,
  });

  if (isPending) {
    return (
      <div className="grid max-w-[1030px] gap-3 px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-6" />
        <Skeleton className="h-6" />
        <Skeleton className="h-6" />
      </div>
    );
  }
  if (data === undefined) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      </div>
    );
  }
  return <CredentialsContent credentials={data} />;
}
