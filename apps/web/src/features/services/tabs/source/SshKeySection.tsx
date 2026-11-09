import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  CopyButton,
  FormBanner,
  Lamp,
  MonoValue,
  Skeleton,
  toast,
} from "../../../../ui";
import { sourceApi, sourceSettingsKey, sourceSettingsQuery } from "./api";

type Dialog = "replace" | "delete" | null;

/** The deploy key, which exists before the source does: it has to be on the host before the first save. */
export function SshKeySection({ project, service }: { project: string; service: string }) {
  const { t } = useTranslation(["service-source", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error } = useQuery(sourceSettingsQuery(project, service));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [generating, setGenerating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: sourceSettingsKey(project, service) });

  const generate = async () => {
    setGenerating(true);
    setFailure(null);
    setTestResult(null);
    try {
      await sourceApi.generateSshKey(project, service);
      await refresh();
      toast.success(t("sshKey.generated"), t("sshKey.generatedHint"));
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setGenerating(false);
    }
  };

  const remove = async () => {
    await sourceApi.deleteSshKey(project, service);
    await refresh();
    setTestResult(null);
    toast.success(t("sshKey.deleted"), t("sshKey.deletedHint"));
  };

  const test = async () => {
    setTesting(true);
    setFailure(null);
    setTestResult(null);
    try {
      setTestResult(await sourceApi.testSshKey(project, service));
      await refresh();
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setTesting(false);
    }
  };

  if (isPending) {
    return <Skeleton className="h-16" />;
  }
  if (isError) {
    return <FormBanner>{errorMessage(error, t)}</FormBanner>;
  }

  const publicKey = data.sshPublicKey;
  const status = data.sshKey;

  return (
    <section className="grid gap-3 border-t pt-4">
      <div>
        <h3 className="text-md font-medium">{t("sshKey.title")}</h3>
        <p className="mt-0.5 text-sm text-muted">{t("sshKey.description")}</p>
      </div>
      {failure !== null && <FormBanner>{failure}</FormBanner>}
      {testResult !== null && (
        <FormBanner tone={testResult.ok ? "success" : "error"}>
          {testResult.ok ? t("sshKey.testOk") : t("sshKey.testFailed", { detail: testResult.detail })}
        </FormBanner>
      )}
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
          {status !== null && (
            <div className="grid gap-1 text-sm">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="text-muted">{t("sshKey.fingerprint")}</span>
                <MonoValue value={status.fingerprint} className="text-xs" />
              </div>
              <Lamp
                state={status.boundTo === null ? "stopped" : "running"}
                label={
                  status.boundTo === null
                    ? t("sshKey.notBound")
                    : t("sshKey.boundTo", { repository: status.boundTo })
                }
                showLabel
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" pending={testing} onClick={test}>
              {t("sshKey.test")}
            </Button>
            <Button size="sm" onClick={() => setDialog("replace")}>
              {t("sshKey.refresh")}
            </Button>
            <Button size="sm" onClick={() => setDialog("delete")}>
              {t("sshKey.delete")}
            </Button>
          </div>
          <ConfirmDialog
            open={dialog === "replace"}
            onOpenChange={(open) => !open && setDialog(null)}
            title={t("sshKey.refreshTitle")}
            description={t("sshKey.refreshDescription")}
            confirmLabel={t("sshKey.refreshConfirm")}
            onConfirm={generate}
          />
          <ConfirmDialog
            open={dialog === "delete"}
            onOpenChange={(open) => !open && setDialog(null)}
            title={t("sshKey.deleteTitle")}
            description={t("sshKey.deleteDescription")}
            confirmLabel={t("sshKey.deleteConfirm")}
            onConfirm={remove}
          />
        </>
      )}
    </section>
  );
}
