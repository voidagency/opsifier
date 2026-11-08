import * as RadixSwitch from "@radix-ui/react-switch";
import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "../lib/cn";

export interface SwitchProps extends ComponentProps<typeof RadixSwitch.Root> {
  label?: ReactNode;
  hint?: ReactNode;
}

export function Switch({ label, hint, className, id, ...props }: SwitchProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = useId();

  const control = (
    <RadixSwitch.Root
      id={controlId}
      aria-describedby={hint ? hintId : undefined}
      {...props}
      className={cn(
        "group relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-sm border border-off bg-raised hover:border-ink disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        !label && className,
      )}
    >
      <RadixSwitch.Thumb className="block size-3 translate-x-[2px] rounded-[2px] bg-off transition-transform duration-[140ms] ease-out group-hover:bg-ink data-[state=checked]:translate-x-[16px] data-[state=checked]:bg-on-accent data-[state=checked]:group-hover:bg-on-accent" />
    </RadixSwitch.Root>
  );

  if (!label) {
    return control;
  }

  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <span className="mt-0.5 inline-flex">{control}</span>
      <span className="grid gap-0.5">
        <label htmlFor={controlId} className="text-sm font-medium">
          {label}
        </label>
        {hint && (
          <span id={hintId} className="text-xs text-muted">
            {hint}
          </span>
        )}
      </span>
    </div>
  );
}
