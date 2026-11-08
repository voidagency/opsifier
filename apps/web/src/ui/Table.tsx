import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="overflow-x-auto">
      <table {...props} className={cn("w-full border-collapse text-sm", className)} />
    </div>
  );
}

export function THead(props: ComponentProps<"thead">) {
  return <thead {...props} />;
}

export function TBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />;
}

export function TR({ className, ...props }: ComponentProps<"tr">) {
  return <tr {...props} className={cn("border-b [tbody_&:hover]:bg-wash", className)} />;
}

interface CellOptions {
  /** IBM Plex Mono with tabular figures, for machine values. */
  mono?: boolean;
  /** Right-aligned, for figures that should line up. */
  numeric?: boolean;
}

export function TH({ className, numeric = false, ...props }: ComponentProps<"th"> & CellOptions) {
  return (
    <th
      scope="col"
      {...props}
      className={cn(
        "eyebrow h-8 whitespace-nowrap px-3 first:pl-0 last:pr-0",
        numeric ? "text-right" : "text-left",
        className,
      )}
    />
  );
}

export function TD({
  className,
  mono = false,
  numeric = false,
  ...props
}: ComponentProps<"td"> & CellOptions) {
  return (
    <td
      {...props}
      className={cn(
        "h-10 px-3 first:pl-0 last:pr-0",
        mono && "font-mono text-xs",
        numeric && "text-right tabular-nums",
        className,
      )}
    />
  );
}
