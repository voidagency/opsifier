import { cn } from "../lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  /** What the group chooses between, for assistive technology. */
  label: string;
}

/** A small choice between a few values, drawn as one ruled control. */
export function Segmented<T extends string>({ value, onChange, options, label }: SegmentedProps<T>) {
  return (
    <fieldset className="m-0 flex border-0 p-0">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-7 border border-off bg-raised px-2.5 text-xs text-muted first:rounded-l-sm last:rounded-r-sm hover:text-ink aria-pressed:bg-wash aria-pressed:font-medium aria-pressed:text-ink",
            "-ml-px first:ml-0",
          )}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
