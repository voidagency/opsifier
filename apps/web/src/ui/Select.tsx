import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./Field";
import { controlClass } from "./Input";

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  /** `sm` sits in a row of small buttons, such as a toolbar. */
  size?: "md" | "sm";
  name?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

export function Select({
  options,
  placeholder,
  size = "md",
  className,
  id,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...root
}: SelectProps) {
  const a11y = useFieldControl({ id, "aria-describedby": ariaDescribedBy, "aria-invalid": ariaInvalid });
  return (
    <RadixSelect.Root {...root}>
      <RadixSelect.Trigger
        {...a11y}
        aria-label={ariaLabel}
        className={cn(
          controlClass,
          "flex items-center justify-between gap-2 text-left data-[placeholder]:text-muted",
          size === "sm" ? "h-7 px-2 text-xs" : "h-9 px-2.5 text-base",
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon>
          <ChevronDown aria-hidden="true" className="size-4 text-muted" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="z-[60] max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-sm border bg-raised shadow-overlay data-[state=open]:animate-drop-in"
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="flex h-8 cursor-default select-none items-center justify-between gap-6 rounded-sm px-2 text-sm outline-none data-[highlighted]:bg-wash data-[disabled]:opacity-50"
              >
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator>
                  <Check aria-hidden="true" className="size-3.5 text-accent" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
