import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { useFieldControl } from "./Field";

export const controlClass =
  "w-full rounded-sm border border-off bg-raised text-ink placeholder:text-muted hover:border-ink focus-visible:border-accent focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-off aria-[invalid=true]:border-bad";

export interface InputProps extends ComponentProps<"input"> {
  /** Sets the value in IBM Plex Mono: hosts, ports, images and other machine values. */
  mono?: boolean;
}

export function Input({ mono = false, className, ...props }: InputProps) {
  const a11y = useFieldControl(props);
  return (
    <input
      {...props}
      {...a11y}
      className={cn(controlClass, "h-9 px-2.5 text-base", mono && "font-mono text-sm", className)}
    />
  );
}

export type PasswordInputProps = Omit<InputProps, "type" | "mono">;

export function PasswordInput({ className, ...props }: PasswordInputProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  // A cleared field starts hidden again, so the next value isn't exposed by an earlier toggle.
  useEffect(() => {
    if (props.value === "") {
      setVisible(false);
    }
  }, [props.value]);

  return (
    <div className="relative">
      <Input {...props} type={visible ? "text" : "password"} className={cn("pr-9", className)} />
      <button
        type="button"
        onClick={() => setVisible((value) => !value)}
        aria-label={visible ? t("field.hidePassword") : t("field.showPassword")}
        aria-pressed={visible}
        className="absolute inset-y-1 right-1 flex w-7 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
      >
        {visible ? (
          <EyeOff aria-hidden="true" className="size-4" />
        ) : (
          <Eye aria-hidden="true" className="size-4" />
        )}
      </button>
    </div>
  );
}

export interface TextareaProps extends ComponentProps<"textarea"> {
  mono?: boolean;
}

export function Textarea({ mono = false, className, rows = 4, ...props }: TextareaProps) {
  const a11y = useFieldControl(props);
  return (
    <textarea
      rows={rows}
      {...props}
      {...a11y}
      className={cn(controlClass, "block px-2.5 py-1.5 text-base", mono && "font-mono text-sm", className)}
    />
  );
}
