import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import { Button, ConfirmDialog, CopyButton, FormBanner, Skeleton, toast } from "../../../../ui";
import { sourceApi, sourceSettingsKey, sourceSettingsQuery } from "./api";

/** The deploy key, which exists before the source does: it has to be on the host before the first save. */
export function SshKeySection({ project, service }: { project: string; service: string }) {
  const { t } = useTranslation(["service-source", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error } = useQuery(sourceSettingsQuery(project, service));
  const [confirming, setConfirming] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const generate = async () => {
    setGenerating(true);
    setFailure(null);
    try {
      await sourceApi.generateSshKey(project, service);
      await queryClient.invalidateQueries({ queryKey: sourceSettingsKey(project, service) });
      toast.success(t("sshKey.generated"), t("sshKey.generatedHint"));
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setGenerating(false);
    }
  };

  if (isPending) {
    return <Skeleton className="h-16" />;
  }
  if (isError) {
    return <FormBanner>{errorMessage(error, t)}</FormBanner>;
  }

  const publicKey = data.sshPublicKey;

  return (
    <section className="grid gap-3 border-t pt-4">
      <div>
        <h3 className="text-md font-medium">{t("sshKey.title")}</h3>
        <p className="mt-0.5 text-sm text-muted">{t("sshKey.description")}</p>
      </div>
      {failure !== null && <FormBanner>{failure}</FormBanner>}
      {publicKey === null ? (
        <div>
          <Button onClick={generate} pending={generating}>
            {t("sshKey.generate")}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2 rounded-sm border bg-raised p-2.5">
            <code className="min-w-0 flex-1 font-mono text-xs break-all">{publicKey}</code>
            <CopyButton value={publicKey} label={t("sshKey.copy")} />
          </div>
          <div>
            <Button size="sm" onClick={() => setConfirming(true)}>
              {t("sshKey.refresh")}
            </Button>
          </div>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t("sshKey.refreshTitle")}
            description={t("sshKey.refreshDescription")}
            confirmLabel={t("sshKey.refreshConfirm")}
            onConfirm={generate}
          />
        </>
      )}
    </section>
  );
}
