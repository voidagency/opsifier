import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { defaultThresholds, levelColor, readQuantity, type Thresholds } from "./quantity";
import "./strings";

export interface GaugeBarProps {
  /** The reading, in the same unit as `max`. Null or undefined draws the no-data state. */
  value: number | null | undefined;
  max?: number;
  /** What is being measured. Becomes the meter's accessible name. */
  label: string;
  thresholds?: Thresholds;
  /** The value printed at the end of the bar, in the mono font. Off when `showValue` is false. */
  display?: string;
  showValue?: boolean;
  /** The reading in words, for assistive technology and the tooltip. Defaults to `display`. */
  valueText?: string;
  className?: string;
}

/** The compact form of a gauge, for table rows and tight columns. The scale marks stand at the thresholds. */
export function GaugeBar({
  value,
  max = 100,
  label,
  thresholds = defaultThresholds,
  display,
  showValue = true,
  valueText,
  className,
}: GaugeBarProps) {
  const { t } = useTranslation("visual");
  const reading = readQuantity(value, max, thresholds);

  const noData = t("quantity.noData");
  const printed = reading === null ? "–" : (display ?? reading.percent);
  const spokenValue = reading === null ? noData : (valueText ?? printed);
  const roles =
    reading === null
      ? ({ role: "img", "aria-label": `${label}: ${noData}` } as const)
      : ({
          role: "meter",
          "aria-label": label,
          "aria-valuemin": 0,
          "aria-valuemax": max,
          "aria-valuenow": reading.value,
          "aria-valuetext": spokenValue,
        } as const);

  return (
    <span
      {...roles}
      title={`${label}: ${spokenValue}`}
      className={cn("inline-flex w-full min-w-16 items-center gap-2", className)}
    >
      <span className="relative block h-2.5 min-w-0 flex-1">
        {reading === null ? (
          <span
            className="absolute inset-x-0 top-1/2 block h-1.5 -translate-y-1/2"
            style={{
              backgroundImage: "repeating-linear-gradient(90deg, var(--off) 0 4px, transparent 4px 7px)",
            }}
          />
        ) : (
          <>
            <span className="absolute inset-x-0 top-1/2 block h-1.5 -translate-y-1/2 overflow-hidden rounded-[1px] bg-[var(--track)]">
              <span
                className="block h-full rounded-[1px]"
                style={{ width: `${reading.fraction * 100}%`, backgroundColor: levelColor[reading.level] }}
              />
            </span>
            {(["busy", "bad"] as const).map((level) => (
              <span
                key={level}
                className="absolute inset-y-0 w-px bg-muted"
                style={{ left: `${thresholds[level] * 100}%` }}
              />
            ))}
          </>
        )}
      </span>
      {showValue && (
        <span className={cn("shrink-0 font-mono text-xs tabular-nums", reading === null && "text-muted")}>
          {printed}
        </span>
      )}
    </span>
  );
}
