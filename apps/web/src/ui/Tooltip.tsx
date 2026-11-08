import * as Radix from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export const TooltipProvider = Radix.Provider;

export interface TooltipProps {
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** Exactly one focusable element. */
  children: ReactNode;
}

export function Tooltip({ content, side = "bottom", children }: TooltipProps) {
  return (
    <Radix.Root>
      <Radix.Trigger asChild>{children}</Radix.Trigger>
      <Radix.Portal>
        <Radix.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[80] max-w-[260px] rounded-sm bg-ink px-2 py-1 text-xs text-bg data-[state=closed]:animate-fade-out data-[state=delayed-open]:animate-fade-in data-[state=instant-open]:animate-fade-in"
        >
          {content}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
