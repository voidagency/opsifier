import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../lib/forms";
import { ConfirmDialog, FormBanner, Switch, toast } from "../../../ui";
import { useCurrentUser } from "../../auth/session";
import { accessApi, twoFactorPolicyQuery } from "./api";

/** The owner's switch that keeps every account without two-factor sign-in to turning it on. */
export function TwoFactorPolicySection() {
  const { t } = useTranslation("settings-access");
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const { data, isError, error } = useQuery(twoFactorPolicyQuery);
  const [confirming, setConfirming] = useState(false);

  if (isError) {
    return <FormBanner>{errorMessage(error, t)}</FormBanner>;
  }
  if (data === undefined) {
    return null;
  }

  const save = async (required: boolean) => {
    await accessApi.saveTwoFactorPolicy({ required });
    await queryClient.invalidateQueries({ queryKey: ["users"] });
    toast.success(t(required ? "twoFactorPolicy.requiredDone" : "twoFactorPolicy.notRequiredDone"));
    return true;
  };

  // Required of everyone while the owner lacks it, it would keep the owner out as well.
  const reason = !data.canChange
    ? t("twoFactorPolicy.ownerOnly")
    : !data.required && currentUser?.twoFactorEnabled !== true
      ? t("twoFactorPolicy.ownFirst")
      : undefined;

  return (
    <section className="border-y py-3">
      <Switch
        label={t("twoFactorPolicy.require")}
        hint={
          reason ??
          t(data.required ? "twoFactorPolicy.requiredHint" : "twoFactorPolicy.hint", {
            count: data.accountsWithout,
          })
        }
        checked={data.required}
        disabled={reason !== undefined}
        onCheckedChange={(required) => {
          if (required) {
            setConfirming(true);
          } else {
            save(false).catch((reason: unknown) => toast.error(errorMessage(reason, t)));
          }
        }}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="primary"
        title={t("twoFactorPolicy.confirmTitle")}
        description={t("twoFactorPolicy.confirmDescription", { count: data.accountsWithout })}
        confirmLabel={t("twoFactorPolicy.confirm")}
        onConfirm={() => save(true)}
      />
    </section>
  );
}
