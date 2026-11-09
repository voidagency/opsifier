import {
  type ServerPurpose,
  type ServerPurposeState,
  type ShownOnceCredentials,
  serverPurposes,
} from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { Button, ConfirmDialog, Dialog, FormBanner, Pictogram } from "../../ui";
import { useCurrentUser } from "../auth/session";
import { purposeApi, refreshPurpose } from "./api";
import { CredentialsShownOnce } from "./CredentialsShownOnce";
import { purposeLook } from "./purpose";

/**
 * Asks what this server is for, the first time an administrator signs in, until it has been chosen.
 * Until then the server is protected, so putting this off costs nothing.
 */
export function FirstUsePrompt({ state }: { state: ServerPurposeState }) {
  const { t } = useTranslation(["server-purpose", "common"]);
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const [later, setLater] = useState(false);
  const [confirmingProduction, setConfirmingProduction] = useState(false);
  const [credentials, setCredentials] = useState<ShownOnceCredentials | null>(null);
  const [pending, setPending] = useState<ServerPurpose | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = async (purpose: ServerPurpose, confirm?: string) => {
    setError(null);
    setPending(purpose);
    try {
      const result = await purposeApi.set(purpose, confirm);
      await refreshPurpose(queryClient);
      setCredentials(result.credentials);
    } catch (failure) {
      if (purpose === "production") {
        throw failure;
      }
      setError(errorMessage(failure, t));
    } finally {
      setPending(null);
    }
  };

  if (credentials !== null) {
    return (
      <Dialog
        open
        onOpenChange={() => undefined}
        title={t("firstUse.credentialsTitle")}
        size="md"
        footer={
          <Button variant="primary" onClick={() => setCredentials(null)}>
            {t("credentialsOnce.done")}
          </Button>
        }
      >
        <CredentialsShownOnce credentials={credentials} />
      </Dialog>
    );
  }

  if (state.purpose !== null || user?.role !== "admin" || later) {
    return null;
  }

  return (
    <>
      <Dialog
        open={!confirmingProduction}
        onOpenChange={(open) => {
          if (!open) {
            setLater(true);
          }
        }}
        title={t("firstUse.title")}
        description={t("firstUse.description")}
        size="lg"
        footer={
          <Button variant="ghost" onClick={() => setLater(true)}>
            {t("firstUse.later")}
          </Button>
        }
      >
        <div className="grid gap-3">
          <ul className="grid gap-2 sm:grid-cols-3">
            {serverPurposes.map((purpose) => {
              const look = purposeLook[purpose];
              return (
                <li key={purpose} className="contents">
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() =>
                      purpose === "production" ? setConfirmingProduction(true) : void apply(purpose)
                    }
                    className="grid gap-2 rounded-sm border p-3 text-left hover:bg-wash disabled:opacity-60"
                  >
                    <span className="flex items-center gap-2 font-medium" style={{ color: look.color }}>
                      <Pictogram name={look.pictogram} size={20} />
                      <span className="text-ink">{t(`purposes.${purpose}`)}</span>
                    </span>
                    <span className="text-xs text-muted">{t(`purposeHints.${purpose}`)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {error !== null && <FormBanner>{error}</FormBanner>}
          <p className="text-xs text-muted">{t("firstUse.meanwhile")}</p>
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmingProduction}
        onOpenChange={setConfirmingProduction}
        title={t("toProduction.title")}
        description={t("toProduction.description", { count: state.totalCount })}
        confirmText={state.confirmation}
        confirmLabel={t("toProduction.confirm")}
        onConfirm={() => apply("production", state.confirmation)}
      />
    </>
  );
}
