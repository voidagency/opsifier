import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../lib/forms";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field } from "./Field";
import { FormBanner } from "./FormBanner";
import { Input } from "./Input";
import { MonoValue } from "./MonoValue";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** "danger" for anything that cannot be undone. */
  tone?: "danger" | "primary";
  /** When set, the confirm button stays off until exactly this text has been typed. */
  confirmText?: string;
  /**
   * May return a promise: the dialog waits for it, and stays open with the error if it rejects.
   * Returning `false` keeps it open with no message, for problems the caller already shows itself.
   */
  onConfirm: () => unknown;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  tone = "danger",
  confirmText,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
    }
  }, [open]);

  const armed = confirmText === undefined || typed === confirmText;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!armed || pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      if ((await onConfirm()) !== false) {
        onOpenChange(false);
      }
    } catch (cause) {
      setError(errorMessage(cause, t));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          onOpenChange(next);
        }
      }}
      title={title}
      description={description}
      size="sm"
      onSubmit={handleSubmit}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {cancelLabel ?? t("actions.cancel")}
          </Button>
          <Button type="submit" variant={tone} disabled={!armed} pending={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {children}
        {confirmText !== undefined && (
          <Field
            label={
              <>
                {t("confirm.typeToConfirm")} <MonoValue value={confirmText} className="font-medium" />
              </>
            }
          >
            <Input
              mono
              value={typed}
              onChange={(event) => setTyped(event.currentTarget.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
        )}
        {error && <FormBanner>{error}</FormBanner>}
      </div>
    </Dialog>
  );
}
