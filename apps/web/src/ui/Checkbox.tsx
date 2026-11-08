import { Check } from "lucide-react";
import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "../lib/cn";

export interface CheckboxProps extends Omit<ComponentProps<"input">, "type"> {
  label?: ReactNode;
  hint?: ReactNode;
}

export function Checkbox({ label, hint, className, id, ...props }: CheckboxProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = useId();

  const box = (
    <span className="relative inline-flex size-4 shrink-0">
      <input
        id={controlId}
        type="checkbox"
        aria-describedby={hint ? hintId : undefined}
        {...props}
        className="peer size-4 cursor-pointer appearance-none rounded-sm border border-off bg-raised hover:border-ink checked:border-accent checked:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Check
        aria-hidden="true"
        strokeWidth={3}
        className="pointer-events-none absolute inset-0.5 size-3 text-on-accent opacity-0 peer-checked:opacity-100"
      />
    </span>
  );

  if (!label) {
    return box;
  }

  return (
    <div className={cn("flex items-start gap-2", className)}>
      <span className="mt-0.5 inline-flex">{box}</span>
      <span className="grid gap-0.5">
        <label htmlFor={controlId} className="cursor-pointer text-sm">
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
