import { type ComponentProps, type KeyboardEvent, useId, useRef, useState } from "react";
import { cn } from "../../../../lib/cn";
import { Input } from "../../../../ui";

export interface ComboboxOption {
  value: string;
  /** Shown instead of the value. */
  label?: string;
  /** A short remark after the label, such as "Private". */
  note?: string;
}

export interface ComboboxProps extends Omit<ComponentProps<typeof Input>, "value" | "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<ComboboxOption | string>;
  /** Filter the options by what is typed. Turned off when the server already did. */
  filter?: boolean;
  /** Shown in place of the list when there is nothing to offer. */
  emptyText?: string;
}

const normalized = (option: ComboboxOption | string): ComboboxOption =>
  typeof option === "string" ? { value: option } : option;

/** A text field that also offers choices. Anything may be typed: the list only suggests. */
export function Combobox({
  value,
  onValueChange,
  options,
  filter = true,
  emptyText,
  onFocus,
  onBlur,
  onKeyDown,
  className,
  ...props
}: ComboboxProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLDivElement>(null);

  const needle = value.trim().toLowerCase();
  const choices = options.map(normalized);
  // A value that is already one of the choices isn't a search: the whole list is still on offer.
  const isChoice = choices.some((option) => option.value.toLowerCase() === needle);
  const visible =
    filter && needle !== "" && !isChoice
      ? choices.filter((option) => option.value.toLowerCase().includes(needle))
      : choices;

  const select = (option: ComboboxOption) => {
    onValueChange(option.value);
    setOpen(false);
    setActive(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (visible.length === 0) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = (active + step + visible.length) % visible.length;
      setActive(next);
      list.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && open) {
      const option = visible[active];
      if (option !== undefined) {
        // Choosing from the list must not submit the form the field is in.
        event.preventDefault();
        select(option);
      } else {
        setOpen(false);
      }
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const showList = open && (visible.length > 0 || emptyText !== undefined);

  return (
    <div className="relative">
      <Input
        {...props}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 && showList ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        mono
        className={className}
        value={value}
        onChange={(event) => {
          onValueChange(event.currentTarget.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={(event) => {
          setOpen(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setOpen(false);
          onBlur?.(event);
        }}
        onKeyDown={handleKeyDown}
      />
      {showList && (
        <div
          ref={list}
          id={listId}
          role="listbox"
          className="absolute z-40 mt-1 max-h-56 w-full overflow-y-auto rounded-sm border bg-raised p-1 shadow-overlay"
        >
          {visible.map((option, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: arrow keys on the input drive the options
            <div
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              // Keeps the input focused, so the list doesn't close before the choice lands.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(option)}
              className={cn(
                "flex cursor-default items-baseline justify-between gap-4 rounded-sm px-2 py-1.5 font-mono text-sm",
                index === active ? "bg-wash" : "hover:bg-wash",
              )}
            >
              <span className="min-w-0 truncate">{option.label ?? option.value}</span>
              {option.note !== undefined && (
                <span className="shrink-0 font-sans text-xs text-muted">{option.note}</span>
              )}
            </div>
          ))}
          {visible.length === 0 && <p className="px-2 py-1.5 text-sm text-muted">{emptyText}</p>}
        </div>
      )}
    </div>
  );
}
