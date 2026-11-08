import { type RedirectRule, saveRedirectRequest } from "@opsifier/contract";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../../../lib/forms";
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FormBanner,
  Input,
  Switch,
  toast,
} from "../../../../ui";
import { redirectsApi } from "./api";

const EXAMPLES = [
  {
    key: "stripWww",
    regex: "^https?://www\\.my-domain\\.com/(.*)",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text of a replacement template
    replacement: "https://my-domain.com/${1}",
  },
  {
    key: "addWww",
    regex: "^https?://my-domain\\.com/(.*)",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text of a replacement template
    replacement: "https://www.my-domain.com/${1}",
  },
  {
    key: "oldDomain",
    regex: "^https?://old-domain\\.com/(.*)",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text of a replacement template
    replacement: "https://new-domain.com/${1}",
  },
  {
    key: "oldPath",
    regex: "^(.*)/old-path",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text of a replacement template
    replacement: "${1}/new-path",
  },
] as const;

interface RedirectFormValues {
  enabled: boolean;
  regex: string;
  replacement: string;
  permanent: boolean;
  [key: string]: unknown;
}

const blank: RedirectFormValues = { enabled: true, regex: "", replacement: "", permanent: false };

export interface RedirectDialogProps {
  project: string;
  service: string;
  /** The rule being edited, or undefined to create one. */
  rule?: RedirectRule;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

function RedirectForm({ project, service, rule, onClose, onSaved }: RedirectDialogProps) {
  const { t } = useTranslation(["service-redirects", "common"]);
  const form = useForm<RedirectFormValues>({
    t,
    initialValues:
      rule === undefined
        ? blank
        : {
            enabled: rule.enabled,
            regex: rule.regex,
            replacement: rule.replacement,
            permanent: rule.permanent,
          },
    validate: (values) =>
      schemaErrors<"regex" | "replacement">(saveRedirectRequest, values, {
        regex: t("errors.regex"),
        replacement: t("errors.replacement"),
      }),
    onSubmit: async (values) => {
      if (rule === undefined) {
        await redirectsApi.create(project, service, values);
      } else {
        await redirectsApi.update(project, service, rule.id, values);
      }
      await onSaved();
      toast.success(t("saved"));
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      title={rule === undefined ? t("dialog.createTitle") : t("dialog.updateTitle")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {rule === undefined ? t("dialog.create") : t("dialog.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                {t("dialog.loadExample")}
                <ChevronDown aria-hidden="true" className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {EXAMPLES.map((example) => (
                <DropdownMenuItem
                  key={example.key}
                  onSelect={() => {
                    form.set("regex", example.regex);
                    form.set("replacement", example.replacement);
                  }}
                >
                  {t(`examples.${example.key}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Switch
          label={t("dialog.enabled")}
          hint={t("dialog.enabledHint")}
          checked={form.values.enabled}
          onCheckedChange={(checked) => form.set("enabled", checked)}
        />
        <Field label={t("dialog.regex")} hint={t("dialog.regexHint")} error={form.errors.regex}>
          <Input
            {...form.field("regex")}
            mono
            placeholder="^https?://…"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label={t("dialog.replacement")}
          hint={t("dialog.replacementHint")}
          error={form.errors.replacement}
        >
          <Input
            {...form.field("replacement")}
            mono
            placeholder="https://example.com/$1"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Switch
          label={t("dialog.permanent")}
          hint={t("dialog.permanentHint")}
          checked={form.values.permanent}
          onCheckedChange={(checked) => form.set("permanent", checked)}
        />
      </div>
    </Dialog>
  );
}

export function RedirectDialog(props: RedirectDialogProps) {
  return <RedirectForm key={props.rule?.id ?? "new"} {...props} />;
}
