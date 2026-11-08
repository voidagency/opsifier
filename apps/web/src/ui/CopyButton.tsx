import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "../lib/clipboard";
import { cn } from "../lib/cn";
import { toast } from "./Toast";

/** Copies a value and exposes a short-lived `copied` flag for the confirmation. */
export function useCopy(value: string) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    const ok = await copyText(value);
    if (!ok) {
      toast.error(t("copy.failed"));
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }, [value, t]);

  return { copied, copy };
}

export interface CopyButtonProps {
  value: string;
  /** What is being copied, for assistive technology: "Copy setup key". Defaults to "Copy". */
  label?: string;
  className?: string;
}

export function CopyButton({ value, label, className }: CopyButtonProps) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy(value);
  const name = copied ? t("copy.copied") : (label ?? t("copy.copy"));

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={name}
      title={name}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink",
        className,
      )}
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3.5 text-ok" />
      ) : (
        <Copy aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );
}
