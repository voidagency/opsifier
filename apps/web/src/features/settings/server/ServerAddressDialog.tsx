import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { systemInfoQuery } from "../../../app/shell/systemInfo";
import { useForm } from "../../../lib/forms";
import { Button, Dialog, Field, FormBanner, Input, toast } from "../../../ui";
import { canonicalIp, sslipBase } from "../../onboarding/address";
import { serverApi } from "./api";

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** Whether a value could be an IP, to show the name it gives before saving. The server checks it for good. */
const looksLikeIp = (value: string) =>
  IPV4.test(value) || (/^[0-9a-f:.]+$/i.test(value) && value.includes(":"));

/**
 * The address people reach the server on, set by hand. A server behind NAT, as most cloud servers are,
 * only sees a private address on its own network, and names generated from it lead nowhere.
 */
export function ServerAddressDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["settings-general", "common"]);
  const queryClient = useQueryClient();
  const { data } = useQuery(systemInfoQuery);
  const form = useForm({
    t,
    initialValues: { ip: "" },
    validate: ({ ip }) => (ip.trim() === "" ? { ip: t("address.required") } : {}),
    onSubmit: async ({ ip }) => {
      const given = ip.trim();
      const entry = await serverApi.setIp(given);
      toast.success(entry.title);
      onOpenChange(false);
      // A page open at the panel's old name on sslip.io would stop answering: it moves to the new one.
      const before = data?.serverIp ?? null;
      if (before !== null && window.location.hostname === `panel.${sslipBase(before)}`) {
        const { pathname, search, hash } = window.location;
        window.location.assign(`https://panel.${sslipBase(canonicalIp(given))}${pathname}${search}${hash}`);
        return;
      }
      // Generated names moved with it: every page that shows one reads it again.
      await queryClient.invalidateQueries();
    },
  });
  const { reset } = form;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refilled each time it opens
  useEffect(() => {
    if (open) {
      reset({ ip: data?.serverIp ?? "" });
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("address.title")}
      description={t("address.description")}
      size="sm"
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("address.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field
          label={t("address.label")}
          hint={
            looksLikeIp(form.values.ip.trim())
              ? t("address.panelThen", {
                  url: `https://panel.${sslipBase(canonicalIp(form.values.ip.trim()))}`,
                })
              : t("address.hint")
          }
          error={form.errors.ip}
        >
          <Input
            {...form.field("ip")}
            mono
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="203.0.113.10"
          />
        </Field>
      </div>
    </Dialog>
  );
}
