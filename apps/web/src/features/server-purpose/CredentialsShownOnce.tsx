import type { ShownOnceCredentials } from "@opsifier/contract";
import { useTranslation } from "react-i18next";
import { FormBanner, MonoValue } from "../../ui";

/** The one time a generated password is visible. Nothing can bring it back afterwards. */
export function CredentialsShownOnce({ credentials }: { credentials: ShownOnceCredentials }) {
  const { t } = useTranslation("server-purpose");
  return (
    <div className="grid gap-3">
      <FormBanner tone="warning">{t("credentialsOnce.warning")}</FormBanner>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">{t("credentialsOnce.username")}</dt>
        <dd className="m-0">
          <MonoValue
            value={credentials.username}
            copy
            copyLabel={t("credentialsOnce.copyUsername")}
            truncate
          />
        </dd>
        <dt className="text-muted">{t("credentialsOnce.password")}</dt>
        <dd className="m-0">
          <MonoValue
            value={credentials.password}
            copy
            copyLabel={t("credentialsOnce.copyPassword")}
            truncate
          />
        </dd>
      </dl>
    </div>
  );
}
