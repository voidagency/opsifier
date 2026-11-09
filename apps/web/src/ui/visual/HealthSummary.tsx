import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Lamp } from "./Lamp";
import {
  type HealthCounts,
  overallState,
  problemCount,
  stateLanguage,
  type VisualState,
  visualStates,
} from "./state";
import "./strings";

export interface HealthSummaryProps {
  counts: HealthCounts;
  /** The state currently filtered on, if any. */
  selected?: VisualState | null;
  /** Makes each count a filter control. Choosing the selected state again clears it, passing null. */
  onSelect?: (state: VisualState | null) => void;
  /** `strip` opens a page. `row` fits a header line and only lists the states something is in. */
  variant?: "strip" | "row";
  /** Names the group for assistive technology. */
  label?: string;
  /** Replaces a state's word where it reads differently: a finished Action "Succeeded", not "Running". */
  stateLabels?: Partial<Record<VisualState, string>>;
  className?: string;
}

interface CountProps {
  state: VisualState;
  count: number;
  selected: boolean;
  onSelect: HealthSummaryProps["onSelect"];
  name: string;
  className: string;
  children: ReactNode;
}

/** One count: a filter button when there is something to filter, otherwise plain and named for assistive technology. */
function Count({ state, count, selected, onSelect, name, className, children }: CountProps) {
  if (onSelect === undefined) {
    return (
      <span role="img" aria-label={name} title={name} className={className}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={name}
      aria-pressed={selected}
      title={name}
      disabled={count === 0 && !selected}
      onClick={() => onSelect(selected ? null : state)}
      className={cn(
        className,
        "cursor-pointer -outline-offset-2 enabled:hover:bg-wash disabled:cursor-default",
      )}
    >
      {children}
    </button>
  );
}

/** Pages open with this: the overall state, then every state's count, problems first, always in the same place. */
function HealthStrip({
  counts,
  selected = null,
  onSelect,
  label,
  stateLabels,
  className,
}: Omit<HealthSummaryProps, "variant">) {
  const { t } = useTranslation("visual");
  const stateName = (state: VisualState) => stateLabels?.[state] ?? t(stateLanguage[state].labelKey);
  const overall = overallState(counts);
  const problems = problemCount(counts);
  const headline =
    overall === null
      ? t("health.empty")
      : problems > 0
        ? t("health.problems", { count: problems })
        : overall === "running"
          ? t("health.allClear")
          : stateName(overall);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would need a legend inside this one-line strip
    <div
      role="group"
      aria-label={label ?? t("health.label")}
      className={cn("@container border-y", className)}
    >
      <div className="grid @3xl:grid-cols-[minmax(11rem,auto)_1fr]">
        <div className="flex items-center gap-3 border-b py-3 pr-5 @3xl:border-r @3xl:border-b-0">
          <Lamp state={overall ?? "unknown"} size="lg" decorative />
          <span className="text-md font-medium whitespace-nowrap">{headline}</span>
        </div>
        {/* Each cell draws its own hairlines, so they stay right however the counts wrap. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] overflow-hidden">
          {visualStates.map((state) => {
            const count = counts[state] ?? 0;
            const isSelected = selected === state;
            return (
              <Count
                key={state}
                state={state}
                count={count}
                selected={isSelected}
                onSelect={onSelect}
                name={t("health.count", { state: stateName(state), count })}
                className={cn(
                  "relative grid grid-cols-[auto_1fr] items-center gap-x-2 px-3 py-2.5 text-left shadow-[1px_0_0_var(--rule),0_1px_0_var(--rule)]",
                  isSelected && "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent",
                )}
              >
                <Lamp
                  state={state}
                  size="md"
                  still
                  decorative
                  className={cn(count === 0 && !isSelected && "opacity-35")}
                />
                <span className={cn("font-mono text-xl tabular-nums", count === 0 && "text-muted")}>
                  {count}
                </span>{" "}
                <span
                  className={cn(
                    "col-span-2 text-xs whitespace-nowrap",
                    isSelected ? "font-medium text-ink" : "text-muted",
                  )}
                >
                  {stateName(state)}
                </span>
              </Count>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The compact form for page headers: only what is non-zero, problems first. */
function HealthRow({
  counts,
  selected = null,
  onSelect,
  label,
  stateLabels,
  className,
}: Omit<HealthSummaryProps, "variant">) {
  const { t } = useTranslation("visual");
  const stateName = (state: VisualState) => stateLabels?.[state] ?? t(stateLanguage[state].labelKey);
  const present = visualStates.filter((state) => (counts[state] ?? 0) > 0 || state === selected);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would need a legend inside this one-line row
    <div
      role="group"
      aria-label={label ?? t("health.label")}
      className={cn("inline-flex items-center gap-0.5", className)}
    >
      {present.length === 0 ? (
        <Lamp state="unknown" size="sm" label={t("health.empty")} />
      ) : (
        present.map((state) => {
          const isSelected = selected === state;
          return (
            <Count
              key={state}
              state={state}
              count={counts[state] ?? 0}
              selected={isSelected}
              onSelect={onSelect}
              name={t("health.count", { state: stateName(state), count: counts[state] ?? 0 })}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-sm px-1.5",
                isSelected && "bg-wash shadow-[inset_0_-2px_0_var(--accent)]",
              )}
            >
              <Lamp state={state} size="sm" still decorative />
              <span className="font-mono text-xs tabular-nums">{counts[state] ?? 0}</span>
            </Count>
          );
        })
      )}
    </div>
  );
}

/** Health at a glance: how many things are in each state, problems first, each count a filter. */
export function HealthSummary({ variant = "strip", ...props }: HealthSummaryProps) {
  return variant === "row" ? <HealthRow {...props} /> : <HealthStrip {...props} />;
}
