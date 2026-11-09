import { firstInvalidEnvLine } from "@opsifier/contract";
import { Eye } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, useForm } from "../../../../lib/forms";
import { Button, CodeEditor, FormBanner, Tooltip, toast } from "../../../../ui";

export interface VariablesEditorProps {
  /** What is saved, as the server names it. There is nothing to show until someone asks. */
  names: readonly string[];
  label: string;
  submitLabel: string;
  savedTitle: string;
  savedHint: string;
  reveal: () => Promise<{ env: string }>;
  save: (env: string) => Promise<unknown>;
  onSaved?: () => void;
}

function EditorForm({
  initial,
  label,
  submitLabel,
  savedTitle,
  savedHint,
  save,
  onDone,
  canHide,
}: {
  initial: string;
  onDone: () => void;
  canHide: boolean;
} & Pick<VariablesEditorProps, "label" | "submitLabel" | "savedTitle" | "savedHint" | "save">) {
  const { t } = useTranslation(["service-environment", "common"]);
  const form = useForm({
    t,
    initialValues: { env: initial },
    validate: ({ env }) => {
      const line = firstInvalidEnvLine(env);
      return line === null ? {} : { env: t("invalidLine", { line }) };
    },
    onSubmit: async ({ env }) => {
      await save(env);
      toast.success(savedTitle, savedHint);
      onDone();
    },
  });

  return (
    <form onSubmit={form.handleSubmit} noValidate className="grid gap-4">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      {form.errors.env && <FormBanner>{form.errors.env}</FormBanner>}
      <CodeEditor
        value={form.values.env}
        onChange={(value) => form.set("env", value)}
        label={label}
        invalid={form.errors.env !== undefined}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" pending={form.pending}>
          {submitLabel}
        </Button>
        {canHide && (
          <Button type="button" variant="ghost" onClick={onDone}>
            {t("hide")}
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * Variables are named on load, and their values only come after someone asks and the asking is written
 * down. The editor works on the whole text, so editing starts from a reveal too, except with nothing saved.
 */
export function VariablesEditor(props: VariablesEditorProps) {
  const { names, reveal, onSaved } = props;
  const { t } = useTranslation(["service-environment", "common"]);
  const [text, setText] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const open = async () => {
    setRevealing(true);
    setFailure(null);
    try {
      setText((await reveal()).env);
    } catch (error) {
      setFailure(errorMessage(error, t));
    } finally {
      setRevealing(false);
    }
  };

  const close = () => {
    setText(null);
    onSaved?.();
  };

  if (text !== null || names.length === 0) {
    return <EditorForm {...props} initial={text ?? ""} onDone={close} canHide={names.length > 0} />;
  }

  return (
    <div className="grid gap-3">
      {failure && <FormBanner>{failure}</FormBanner>}
      <ul className="grid rounded-sm border">
        {names.map((name) => (
          <li
            key={name}
            className="flex items-center justify-between gap-3 border-b px-3 py-1.5 last:border-b-0"
          >
            <span className="min-w-0 break-all font-mono text-sm">{name}</span>
            <span role="img" aria-label={t("masked")} className="shrink-0 font-mono text-sm text-muted">
              ••••••••
            </span>
          </li>
        ))}
      </ul>
      <div className="flex">
        <Tooltip content={t("revealHint")}>
          <Button type="button" pending={revealing} onClick={() => void open()}>
            <Eye aria-hidden="true" className="size-4" />
            {t("reveal")}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
