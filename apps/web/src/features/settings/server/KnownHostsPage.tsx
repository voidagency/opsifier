import type { KnownHost, ScannedHostKey } from "@opsifier/contract";
import { addKnownHostRequest, knownHostList, scanKnownHostResponse } from "@opsifier/contract";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { errorMessage, useForm } from "../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormBanner,
  Input,
  Lamp,
  MonoValue,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
  toast,
} from "../../../ui";

const BASE = "/settings/known-hosts";

export const knownHostsQuery = queryOptions({
  queryKey: ["known-hosts"] as const,
  queryFn: ({ signal }) => api.get(BASE, { schema: knownHostList, signal }),
  staleTime: 0,
});

const scan = (host: string, port: number) =>
  api.post(`${BASE}/scan`, { body: { host, port }, schema: scanKnownHostResponse });

const trust = (host: string, port: number, publicKey: string) =>
  api.post(BASE, { body: { host, port, publicKey } });

function AddHostDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(["settings-known-hosts", "common"]);
  const queryClient = useQueryClient();
  const [found, setFound] = useState<ScannedHostKey[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const form = useForm({
    t,
    initialValues: { host: "", port: "22", publicKey: "" },
    validate: ({ host, port, publicKey }) => {
      const parsed = addKnownHostRequest.safeParse({
        host,
        port,
        publicKey: publicKey === "" ? "x" : publicKey,
      });
      const errors: Partial<Record<"host" | "port" | "publicKey", string>> = {};
      if (host.trim() === "") {
        errors.host = t("errors.hostRequired");
      } else if (!parsed.success && parsed.error.issues.some((issue) => issue.path[0] === "host")) {
        errors.host = t("errors.hostInvalid");
      }
      if (!parsed.success && parsed.error.issues.some((issue) => issue.path[0] === "port")) {
        errors.port = t("errors.portInvalid");
      }
      if (
        publicKey !== "" &&
        !parsed.success &&
        parsed.error.issues.some((issue) => issue.path[0] === "publicKey")
      ) {
        errors.publicKey = t("errors.keyRequired");
      }
      return errors;
    },
    onSubmit: async ({ host, port, publicKey }) => {
      if (publicKey.trim() !== "") {
        await trust(host, Number(port), publicKey);
        finish();
        return;
      }
      setFound((await scan(host, Number(port))).items);
    },
  });

  const finish = () => {
    void queryClient.invalidateQueries({ queryKey: knownHostsQuery.queryKey });
    toast.success(t("trusted"));
    setFound(null);
    form.reset({ host: "", port: "22", publicKey: "" });
    onOpenChange(false);
  };

  const trustScanned = async (key: ScannedHostKey) => {
    setSaving(key.publicKey);
    form.setBanner("");
    try {
      await trust(form.values.host, Number(form.values.port), `${key.keyType} ${key.publicKey}`);
      finish();
    } catch (cause) {
      form.setBanner(errorMessage(cause, t));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFound(null);
        }
        onOpenChange(next);
      }}
      title={t("addTitle")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {form.values.publicKey.trim() === "" ? t("scan") : t("trust")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <div className="grid grid-cols-[minmax(0,1fr)_6rem] items-start gap-3">
          <Field label={t("host")} hint={t("hostHint")} error={form.errors.host}>
            <Input {...form.field("host")} mono autoFocus autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={t("port")} hint={t("portHint")} error={form.errors.port}>
            <Input {...form.field("port")} mono inputMode="numeric" />
          </Field>
        </div>
        <Field label={t("publicKey")} optional hint={t("publicKeyHint")} error={form.errors.publicKey}>
          <Input {...form.field("publicKey")} mono autoComplete="off" spellCheck={false} />
        </Field>
        {found !== null && (
          <div className="grid gap-2">
            <p className="text-sm text-muted">{t("found")}</p>
            <ul className="grid gap-2">
              {found.map((key) => (
                <li
                  key={key.publicKey}
                  className="flex flex-wrap items-center justify-between gap-2 border-t pt-2"
                >
                  <span className="min-w-0">
                    <span className="block text-xs text-muted">{key.keyType}</span>
                    <MonoValue value={key.fingerprint} className="text-xs" />
                  </span>
                  <Button size="sm" pending={saving === key.publicKey} onClick={() => trustScanned(key)}>
                    {t("trust")}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** The SSH hosts Git is allowed to connect to. Anything not listed here is refused. */
export function KnownHostsPage() {
  const { t } = useTranslation(["settings-known-hosts", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(knownHostsQuery);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<KnownHost | null>(null);

  const remove = async () => {
    if (removing === null) {
      return false;
    }
    await api.delete(`${BASE}/${removing.id}`, { schema: knownHostList });
    await queryClient.invalidateQueries({ queryKey: knownHostsQuery.queryKey });
    toast.success(t("removed"));
    return true;
  };

  const hosts = data?.items ?? [];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 px-4 py-6 md:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-[60ch]">
          <h2 className="text-md font-medium">{t("title")}</h2>
          <p className="mt-1 text-sm text-muted">{t("description")}</p>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" className="size-4" />
          {t("add")}
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-24" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : hosts.length === 0 ? (
        <EmptyState illustration="no-domains" title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>{t("host")}</TH>
              <TH>{t("fingerprint")}</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {hosts.map((host) => (
              <TR key={host.id}>
                <TD>
                  <span className="flex items-center gap-2">
                    <Lamp state="running" size="xs" still label={t("trusted")} />
                    <MonoValue
                      value={host.port === 22 ? host.host : `${host.host}:${host.port}`}
                      className="text-sm"
                    />
                  </span>
                  {host.addedBy === null && (
                    <span className="block text-xs text-muted">{t("addedByImported")}</span>
                  )}
                </TD>
                <TD>
                  <span className="block text-xs text-muted">{host.keyType}</span>
                  <MonoValue value={host.fingerprint} truncate className="text-xs" />
                </TD>
                <TD className="text-right">
                  <Tooltip content={t("remove")}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("remove")}
                      onClick={() => setRemoving(host)}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </Button>
                  </Tooltip>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <AddHostDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("removeTitle")}
        description={t("removeDescription")}
        confirmLabel={t("remove")}
        onConfirm={remove}
      />
    </div>
  );
}
