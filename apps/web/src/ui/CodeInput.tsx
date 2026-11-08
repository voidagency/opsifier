import { type ChangeEvent, type ComponentProps, useState } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./Field";

export interface CodeInputProps
  extends Omit<ComponentProps<"input">, "value" | "onChange" | "defaultValue" | "maxLength" | "type"> {
  value: string;
  onChange: (value: string) => void;
  /** Called once when the last digit is entered, typed or pasted. */
  onComplete?: (value: string) => void;
  length?: number;
}

/**
 * A one-time code entry. One real input sits over the digit cells, so paste, password-manager fill
 * and screen readers all get an ordinary text field.
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  length = 6,
  className,
  onFocus,
  onBlur,
  ...props
}: CodeInputProps) {
  const a11y = useFieldControl(props);
  const [focused, setFocused] = useState(false);
  const caret = Math.min(value.length, length - 1);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.currentTarget.value.replace(/\D/g, "").slice(0, length);
    onChange(next);
    if (next.length === length && value.length < length) {
      onComplete?.(next);
    }
  };

  return (
    <div
      className={cn("relative grid gap-1.5", className)}
      style={{ gridTemplateColumns: `repeat(${length}, minmax(0, 2.75rem))` }}
    >
      {Array.from({ length }, (_, index) => (
        <div
          // The cells are positional, so the index is the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length list that never reorders
          key={index}
          aria-hidden="true"
          data-active={focused && index === caret ? true : undefined}
          data-invalid={a11y["aria-invalid"] ? true : undefined}
          className="flex h-11 items-center justify-center rounded-sm border border-off bg-raised font-mono text-md data-[active=true]:border-accent data-[active=true]:outline-2 data-[active=true]:outline-accent data-[invalid=true]:border-bad"
        >
          {value[index] ?? ""}
        </div>
      ))}
      <input
        {...props}
        {...a11y}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={length}
        value={value}
        onChange={handleChange}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        className="absolute inset-0 size-full cursor-text font-mono opacity-0 focus-visible:outline-none"
      />
    </div>
  );
}
