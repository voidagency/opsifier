import type { CreatedStudioGuestLink, StudioGuestLink } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime, formatRelativeTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  CopyButton,
  Dialog,
  Field,
  FormBanner,
  Input,
  Segmented,
  Skeleton,
  Switch,
  toast,
} from "../../ui";
import { studioApi, studioKey, studioLinksQuery } from "./api";

type Validity = "7" | "30" | "none";

/**
 * Links that open the project's preview to clients, who have no account: making one, which shows its
 * address this once, and taking back those already sent.
 */
export function GuestLinksDialog({
  project,
  service,
  name,
  onClose,
}: {
  project: string;
  service: string;
  /** The project's name, as the Studio shows it. */
  name: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const links = useQuery(studioLinksQuery(project, service));
  const [label, setLabel] = useState("");
  const [remarks, setRemarks] = useState(true);
  const [validity, setValidity] = useState<Validity>("30");
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [made, setMade] = useState<CreatedStudioGuestLink | null>(null);
  const [removing, setRemoving] = useState<StudioGuestLink | null>(null);
  const [withRemarks, setWithRemarks] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: [...studioKey, "links", project, service] });

  const create = async () => {
    if (label.trim() === "") {
      setLabelError(t("links.labelRequired"));
      return;
    }
    setCreating(true);
    setFailure(null);
    setLabelError(null);
    try {
      const link = await studioApi.createLink(project, service, {
        label: label.trim(),
        remarks,
        days: validity === "none" ? null : Number(validity),
      });
      setMade(link);
      setLabel("");
      await refresh();
    } catch (reason) {
      setFailure(errorMessage(reason, t));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (link: StudioGuestLink) => {
    await studioApi.removeLink(project, service, link.id, withRemarks && link.remarkCount > 0);
    if (made?.id === link.id) {
      setMade(null);
    }
    await refresh();
    if (withRemarks && link.remarkCount > 0) {
      await queryClient.invalidateQueries({ queryKey: [...studioKey, "remarks", project, service] });
    }
    toast.success(t("links.removed", { label: link.label }));
  };

  const until = (link: StudioGuestLink) =>
    link.expired
      ? t("links.expired")
      : link.expiresAt === null
        ? t("links.noLimit")
        : t("links.until", { date: formatDateTime(link.expiresAt, i18n.language) });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="sm"
      title={t("links.title")}
      description={t("links.description", { name })}
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t("common:actions.close")}
        </Button>
      }
    >
      <div className="grid gap-4">
        {failure !== null && <FormBanner>{failure}</FormBanner>}
        {made !== null && (
          <div className="grid gap-2 rounded-md border border-accent/40 bg-raised p-3" role="status">
            <p className="text-sm font-medium text-ink">{t("links.madeTitle", { label: made.label })}</p>
            <div className="flex min-w-0 items-center gap-1.5">
              <Input
                mono
                readOnly
                aria-label={t("links.address")}
                value={made.url}
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 text-xs"
              />
              <CopyButton value={made.url} label={t("links.copy")} className="size-8" />
            </div>
            <p className="text-xs text-muted">{t("links.madeHint")}</p>
          </div>
        )}
        <div className="grid gap-3 rounded-md border p-3">
          <Field label={t("links.label")} hint={t("links.labelHint")} error={labelError ?? undefined}>
            <Input
              value={label}
              maxLength={80}
              placeholder={t("links.labelPlaceholder")}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Switch
            label={t("links.remarks")}
            hint={t("links.remarksHint")}
            checked={remarks}
            onCheckedChange={setRemarks}
          />
          <div className="grid gap-1.5">
            <span className="text-sm font-medium text-ink">{t("links.validity")}</span>
            <Segmented
              label={t("links.validity")}
              value={validity}
              onChange={setValidity}
              options={[
                { value: "7", label: t("links.days", { count: 7 }) },
                { value: "30", label: t("links.days", { count: 30 }) },
                { value: "none", label: t("links.noLimit") },
              ]}
            />
          </div>
          <Button type="submit" variant="primary" pending={creating} className="justify-self-start">
            {t("links.create")}
          </Button>
        </div>
        <section className="grid gap-2" aria-label={t("links.list")}>
          <h3 className="text-sm font-medium text-ink">{t("links.list")}</h3>
          {links.isError ? (
            <FormBanner>{errorMessage(links.error, t)}</FormBanner>
          ) : links.isPending ? (
            <Skeleton className="h-16" />
          ) : links.data.links.length === 0 ? (
            <p className="text-sm text-muted">{t("links.none")}</p>
          ) : (
            <ul className="grid gap-2">
              {links.data.links.map((link) => (
                <li key={link.id} className="flex min-w-0 items-start gap-2 rounded-md border px-3 py-2">
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-sm font-medium text-ink">{link.label}</span>
                    <span className="text-xs text-muted">
                      {[
                        until(link),
                        link.remarks ? t("links.withRemarks") : t("links.siteOnly"),
                        link.remarkCount > 0 ? t("links.written", { count: link.remarkCount }) : null,
                        link.lastUsedAt === null
                          ? t("links.neverOpened")
                          : t("links.opened", { when: formatRelativeTime(link.lastUsedAt, i18n.language) }),
                        link.createdBy === null ? null : t("links.madeBy", { email: link.createdBy }),
                      ]
                        .filter((part) => part !== null)
                        .join(" · ")}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setWithRemarks(false);
                      setRemoving(link);
                    }}
                  >
                    {t("links.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {removing !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(null)}
          title={t("links.removeTitle", { label: removing.label })}
          description={t("links.removeDescription")}
          confirmLabel={t("links.remove")}
          tone="danger"
          onConfirm={async () => {
            await remove(removing);
            setRemoving(null);
          }}
        >
          {removing.remarkCount > 0 && (
            <Checkbox
              label={t("links.removeRemarks", { count: removing.remarkCount })}
              checked={withRemarks}
              onChange={(event) => setWithRemarks(event.currentTarget.checked)}
            />
          )}
        </ConfirmDialog>
      )}
    </Dialog>
  );
}
