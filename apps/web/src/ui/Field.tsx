import { CircleAlert } from "lucide-react";
import { createContext, type ReactNode, useContext, useId } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";

interface FieldContextValue {
  controlId: string;
  messageId: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

interface ControlA11yProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
}

/** Merges a control's own accessibility props with those of the surrounding Field. */
export function useFieldControl(props: ControlA11yProps) {
  const field = useContext(FieldContext);
  const describedBy = [props["aria-describedby"], field?.messageId].filter(Boolean).join(" ");
  return {
    id: props.id ?? field?.controlId,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": props["aria-invalid"] ?? (field?.invalid ? true : undefined),
  };
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Replaces the hint and marks the control invalid. */
  error?: ReactNode;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, optional = false, className, children }: FieldProps) {
  const { t } = useTranslation();
  const controlId = useId();
  const messageId = useId();
  const message = error || hint;

  return (
    <div className={cn("grid gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={controlId} className="text-sm font-medium">
          {label}
        </label>
        {optional && <span className="text-xs text-muted">{t("field.optional")}</span>}
      </div>
      <FieldContext.Provider
        value={{ controlId, messageId: message ? messageId : undefined, invalid: Boolean(error) }}
      >
        {children}
      </FieldContext.Provider>
      {message && (
        <p
          id={messageId}
          className={cn("flex items-start gap-1.5 text-xs", error ? "text-bad" : "text-muted")}
        >
          {error && <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />}
          <span>{message}</span>
        </p>
      )}
    </div>
  );
}
