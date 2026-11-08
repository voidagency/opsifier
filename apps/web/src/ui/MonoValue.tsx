import { cn } from "../lib/cn";
import { CopyButton } from "./CopyButton";

export interface MonoValueProps {
  /** A machine value: host, port, image, ID, size. */
  value: string;
  /** Adds a copy control. */
  copy?: boolean;
  copyLabel?: string;
  /** Keeps to one line and ellipsises, with the full value in a tooltip. */
  truncate?: boolean;
  className?: string;
}

export function MonoValue({ value, copy = false, copyLabel, truncate = false, className }: MonoValueProps) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 align-baseline font-mono", className)}>
      <span className={cn(truncate && "min-w-0 truncate")} title={truncate ? value : undefined}>
        {value}
      </span>
      {copy && <CopyButton value={value} label={copyLabel} />}
    </span>
  );
}
