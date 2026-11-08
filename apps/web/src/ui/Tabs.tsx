import * as Radix from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export const Tabs = Radix.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof Radix.List>) {
  return <Radix.List {...props} className={cn("flex gap-5 border-b", className)} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof Radix.Trigger>) {
  return (
    <Radix.Trigger
      {...props}
      className={cn(
        "-mb-px relative h-9 cursor-pointer whitespace-nowrap text-sm text-muted after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:origin-left after:scale-x-0 after:bg-highlight after:transition-transform after:duration-[160ms] after:ease-out hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 data-[state=active]:font-medium data-[state=active]:text-ink data-[state=active]:after:scale-x-100",
        className,
      )}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof Radix.Content>) {
  return <Radix.Content {...props} className={cn("focus-visible:outline-offset-4", className)} />;
}
