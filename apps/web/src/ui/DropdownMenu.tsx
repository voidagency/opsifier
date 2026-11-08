import * as Radix from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export const DropdownMenu = Radix.Root;
export const DropdownMenuTrigger = Radix.Trigger;
export const DropdownMenuRadioGroup = Radix.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = "end",
  ...props
}: ComponentProps<typeof Radix.Content>) {
  return (
    <Radix.Portal>
      <Radix.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        {...props}
        className={cn(
          "z-50 min-w-[200px] rounded-sm border bg-raised p-1 shadow-overlay focus-visible:outline-none data-[state=closed]:animate-drop-out data-[state=open]:animate-drop-in",
          className,
        )}
      />
    </Radix.Portal>
  );
}

const itemClass =
  "flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-wash";

export function DropdownMenuItem({
  className,
  destructive = false,
  ...props
}: ComponentProps<typeof Radix.Item> & { destructive?: boolean }) {
  return <Radix.Item {...props} className={cn(itemClass, destructive && "text-bad", className)} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Radix.RadioItem>) {
  return (
    <Radix.RadioItem {...props} className={cn(itemClass, "justify-between", className)}>
      <span>{children}</span>
      <Radix.ItemIndicator>
        <Check aria-hidden="true" className="size-3.5 text-accent" />
      </Radix.ItemIndicator>
    </Radix.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Radix.Label>) {
  return <Radix.Label {...props} className={cn("eyebrow px-2 pt-1.5 pb-1", className)} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Radix.Separator>) {
  return <Radix.Separator {...props} className={cn("my-1 h-px bg-rule", className)} />;
}
