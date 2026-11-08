import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface FullscreenPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/** A dialog that takes the whole window, for reading logs at length. */
export function FullscreenPanel({ open, onOpenChange, title, actions, children }: FullscreenPanelProps) {
  const { t } = useTranslation();
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col bg-bg focus-visible:outline-none data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in"
        >
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 md:px-6">
            <RadixDialog.Title className="min-w-0 flex-1 truncate text-md font-medium">
              {title}
            </RadixDialog.Title>
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
            <RadixDialog.Close
              aria-label={t("actions.close")}
              className="flex size-8 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
            >
              <X aria-hidden="true" className="size-4" />
            </RadixDialog.Close>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:p-6">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
