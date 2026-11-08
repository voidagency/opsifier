import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Wraps the body and footer in a form, so Enter submits and a submit button in the footer works. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}

const sizes = { sm: "max-w-[420px]", md: "max-w-[520px]", lg: "max-w-[680px]" };

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  onSubmit,
}: DialogProps) {
  const { t } = useTranslation();

  const body = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer && (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3">{footer}</footer>
      )}
    </>
  );

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-scrim data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <RadixDialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed inset-x-4 top-[max(1rem,9dvh)] z-50 mx-auto flex max-h-[calc(100dvh-2rem)] flex-col rounded-sm border bg-raised shadow-overlay focus-visible:outline-none data-[state=closed]:animate-rise-out data-[state=open]:animate-rise-in sm:max-h-[82dvh]",
            sizes[size],
          )}
        >
          <header className="border-b py-3.5 pr-12 pl-5">
            <RadixDialog.Title className="text-md font-medium">{title}</RadixDialog.Title>
            {description && (
              <RadixDialog.Description className="mt-0.5 text-sm text-muted">
                {description}
              </RadixDialog.Description>
            )}
          </header>
          {onSubmit ? (
            <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
              {body}
            </form>
          ) : (
            body
          )}
          {/* Last in the DOM so focus starts on the dialog's content, not on the way out. */}
          <RadixDialog.Close
            aria-label={t("actions.close")}
            className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
          >
            <X aria-hidden="true" className="size-4" />
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
