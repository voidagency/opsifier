import type { ChangeEventHandler } from "react";
import { useTranslation } from "react-i18next";
import { Field, Input, Textarea } from "../../ui";

/** What has to be true outside the panel before an address answers. */
export function DomainPrerequisites({
  host,
  wildcard,
  https,
  serverIp,
}: {
  host: string;
  wildcard: boolean;
  https: boolean;
  /** Where DNS records should point. Null while the server's address is unknown. */
  serverIp: string | null;
}) {
  const { t } = useTranslation("domains");
  const name = `${wildcard ? "*." : ""}${host.trim() === "" ? t("prerequisites.thisHost") : host.trim()}`;
  const dns =
    serverIp === null
      ? t("prerequisites.dnsUnknown", { name })
      : t("prerequisites.dnsRecord", { type: serverIp.includes(":") ? "AAAA" : "A", name, ip: serverIp });
  const certificate = wildcard ? t("prerequisites.certificateWildcard") : t("prerequisites.certificateAuto");

  return (
    <div className="grid gap-1.5">
      <p className="eyebrow">{t("prerequisites.title")}</p>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted">
        <dt>{t("prerequisites.dns")}</dt>
        <dd className="m-0 min-w-0 break-words font-mono">{dns}</dd>
        <dt>{t("prerequisites.ports")}</dt>
        <dd className="m-0">{https ? t("prerequisites.portsHttps") : t("prerequisites.portsHttp")}</dd>
        {https && (
          <>
            <dt>{t("prerequisites.certificate")}</dt>
            <dd className="m-0">{certificate}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

interface TextControl {
  name: string;
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement | HTMLTextAreaElement>;
}

/** With an HTTPS upstream: what its certificate is checked against. It is never accepted unseen. */
export function UpstreamCertificateFields({
  serverName,
  certificates,
  serverNameError,
  certificatesError,
}: {
  serverName: TextControl;
  certificates: TextControl;
  serverNameError?: string;
  certificatesError?: string;
}) {
  const { t } = useTranslation("domains");
  return (
    <>
      <Field
        label={t("form.upstreamName")}
        hint={t("form.upstreamNameHint")}
        optional
        error={serverNameError}
      >
        <Input {...serverName} mono autoComplete="off" spellCheck={false} autoCapitalize="none" />
      </Field>
      <Field label={t("form.upstreamCa")} hint={t("form.upstreamCaHint")} optional error={certificatesError}>
        <Textarea
          {...certificates}
          mono
          rows={4}
          spellCheck={false}
          placeholder="-----BEGIN CERTIFICATE-----"
        />
      </Field>
    </>
  );
}
