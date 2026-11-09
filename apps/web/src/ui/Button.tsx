import { type ComponentProps, type MouseEvent, type ReactNode, useState } from "react";
import { cn } from "../lib/cn";
import { Tooltip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon" | "icon-sm";

const base =
  "relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-sm font-medium transition-transform duration-[120ms] ease-out active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 data-[pending=true]:cursor-progress data-[pending=true]:active:translate-y-0";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-strong",
  secondary: "border border-off text-ink hover:bg-wash",
  ghost: "text-ink hover:bg-wash",
  danger: "bg-bad text-on-bad hover:bg-bad-strong",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-sm",
  lg: "h-10 px-4 text-base",
  icon: "size-8",
  "icon-sm": "size-7",
};

/** The button look, for links and other elements that must not be a `<button>`. */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md"): string {
  return cn(base, variants[variant], sizes[size]);
}

export interface ButtonProps extends Omit<ComponentProps<"button">, "onClick"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows progress and ignores clicks, without dropping keyboard focus the way `disabled` would. */
  pending?: boolean;
  /** Icon before the label. */
  icon?: ReactNode;
  /** When this returns a promise the button stays pending until it settles. */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => unknown;
  /** Shown on hover and focus, for a button that says what it does in an icon. */
  tooltip?: ReactNode;
  /**
   * Why the button can't be used right now. Set, it reads as off but stays focusable and shows this
   * on hover and focus, which a `disabled` button can't, so nobody has to guess what it needs.
   */
  disabledReason?: ReactNode;
}

export function Button(allProps: ButtonProps) {
  const {
    variant = "secondary",
    size = "md",
    pending = false,
    icon,
    onClick,
    type = "button",
    className,
    children,
    tooltip,
    disabledReason,
    ...props
  } = allProps;
  const [ownPending, setOwnPending] = useState(false);
  const isPending = pending || ownPending;
  const unavailable = Boolean(disabledReason);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (isPending || unavailable) {
      // Also stops a click on a submit button from submitting again.
      event.preventDefault();
      return;
    }
    const result = onClick?.(event);
    if (result instanceof Promise) {
      setOwnPending(true);
      void result.finally(() => setOwnPending(false));
    }
  };

  const button = (
    <button
      type={type}
      className={cn(
        buttonClass(variant, size),
        unavailable && "cursor-not-allowed opacity-45 hover:bg-transparent active:translate-y-0",
        className,
      )}
      aria-busy={isPending || undefined}
      aria-disabled={isPending || unavailable || undefined}
      data-pending={isPending || undefined}
      onClick={handleClick}
      {...props}
    >
      {icon}
      {children}
      {isPending && (
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
          <span className="block h-full w-1/3 animate-sweep bg-current motion-reduce:w-full motion-reduce:opacity-60" />
        </span>
      )}
    </button>
  );

  // Mounted as soon as a reason can apply, so the button keeps its focus when it becomes available.
  return "tooltip" in allProps || "disabledReason" in allProps ? (
    <Tooltip content={disabledReason || tooltip}>{button}</Tooltip>
  ) : (
    button
  );
}
