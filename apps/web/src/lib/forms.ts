import type { TFunction } from "i18next";
import { type ChangeEvent, type FormEvent, useCallback, useRef, useState } from "react";
import { ApiError, isApiError } from "./api";

export type FieldErrors<K extends string = string> = Partial<Record<K, string>>;

/** What a form displays after a failed submit. */
export interface FormFailure<K extends string = string> {
  banner: string | null;
  fields: FieldErrors<K>;
}

/** A readable sentence for any error a request can throw. Known codes are translated. */
export function errorMessage(error: unknown, t: TFunction): string {
  if (isApiError(error)) {
    if (error.isNetworkError) {
      return t("common:errors.network");
    }
    return t(`common:apiErrors.${error.code}`, { defaultValue: error.message });
  }
  return t("common:errors.unexpected");
}

/**
 * Turns anything thrown by a submit into what the form shows: a banner, plus a message on each field
 * the API named. Messages for fields this form does not display are added to the banner, so nothing
 * the server said gets lost.
 */
export function applyApiError<K extends string>(
  error: unknown,
  fieldNames: readonly K[],
  t: TFunction,
): FormFailure<K> {
  const fields: FieldErrors<K> = {};
  const orphans: string[] = [];
  const summary = errorMessage(error, t);
  if (error instanceof ApiError) {
    const entries = Object.entries(error.fields);
    // A specific failure naming one field, like a wrong password: the field gets the translated
    // reason, and the banner stays general so the two don't repeat each other.
    const specific = t(`common:apiErrors.${error.code}`, { defaultValue: "" });
    if (specific && error.code !== "validation_failed" && entries.length === 1) {
      const name = entries[0]?.[0] ?? "";
      if ((fieldNames as readonly string[]).includes(name)) {
        fields[name as K] = specific;
        return { banner: t("common:apiErrors.validation_failed"), fields };
      }
    }
    for (const [name, message] of entries) {
      if ((fieldNames as readonly string[]).includes(name)) {
        fields[name as K] = message;
      } else {
        orphans.push(message);
      }
    }
  }
  return { banner: [summary, ...orphans].join(" "), fields };
}

interface SafeParser {
  safeParse(values: unknown):
    | { success: true }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };
      };
}

/**
 * Validates against a contract schema before anything is sent. The first problem on each field wins,
 * and `messages` replaces the contract's English wording with the translated text.
 */
export function schemaErrors<K extends string>(
  schema: SafeParser,
  values: unknown,
  messages: Partial<Record<K, string>>,
): FieldErrors<K> {
  const result = schema.safeParse(values);
  const errors: FieldErrors<K> = {};
  if (result.success) {
    return errors;
  }
  for (const issue of result.error.issues) {
    const name = String(issue.path[0]) as K;
    errors[name] ??= messages[name] ?? issue.message;
  }
  return errors;
}

export interface UseFormOptions<V extends Record<string, unknown>> {
  initialValues: V;
  validate?: (values: V) => FieldErrors<keyof V & string>;
  onSubmit: (values: V) => Promise<void> | void;
  t: TFunction;
}

/** Holds a form's values and its submit lifecycle: validation, pending state and API errors. */
export function useForm<V extends Record<string, unknown>>({
  initialValues,
  validate,
  onSubmit,
  t,
}: UseFormOptions<V>) {
  type Name = keyof V & string;
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<FieldErrors<Name>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const set = useCallback(<N extends Name>(name: N, value: V[N]) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => {
      if (current[name] === undefined) {
        return current;
      }
      const { [name]: _cleared, ...rest } = current;
      return rest as FieldErrors<Name>;
    });
  }, []);

  /** Props for a text-like control bound to a string field. */
  const field = <N extends Name>(name: N) => ({
    name,
    value: values[name] as string,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      set(name, event.currentTarget.value as V[N]),
  });

  const reset = useCallback((next: V) => {
    setValues(next);
    setErrors({});
    setBanner(null);
  }, []);

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (pendingRef.current) {
      return;
    }
    const problems = validate?.(values) ?? {};
    setErrors(problems);
    if (Object.keys(problems).length > 0) {
      setBanner(null);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setBanner(null);
    try {
      await onSubmit(values);
    } catch (error) {
      const failure = applyApiError(error, Object.keys(values) as Name[], t);
      setErrors(failure.fields);
      setBanner(failure.banner);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return { values, errors, banner, pending, set, field, reset, setBanner, handleSubmit };
}
