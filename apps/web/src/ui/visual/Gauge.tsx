import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Lamp } from "./Lamp";
import { defaultThresholds, levelColor, readQuantity, type Thresholds } from "./quantity";
import "./strings";

/** The logo's ring: the same stroke-to-radius ratio, with one amber tick at the top. */
const CENTER = 50;
const RADIUS = 40;
const STROKE = 11;
const TICK_HALF_ANGLE = 4.75;
/** The value arc runs clockwise from the tick and meets it again at full capacity. */
const SWEEP = 360 - 2 * TICK_HALF_ANGLE;

const sizes = {
  sm: { pixels: 70, text: "text-xs", textLong: "text-micro", scale: false },
  md: { pixels: 110, text: "text-md", textLong: "text-sm", scale: true },
  lg: { pixels: 160, text: "text-xl", textLong: "text-lg", scale: true },
} as const;

export type GaugeSize = keyof typeof sizes;

/** The degrees of arc a reading takes up. */
export function gaugeSweep(fraction: number): number {
  return fraction * SWEEP;
}

function ScaleMark({ fraction }: { fraction: number }) {
  const radians = ((TICK_HALF_ANGLE + gaugeSweep(fraction) - 90) * Math.PI) / 180;
  const point = (radius: number) => ({
    x: CENTER + radius * Math.cos(radians),
    y: CENTER + radius * Math.sin(radians),
  });
  const from = point(RADIUS + STROKE / 2 + 1);
  const to = point(RADIUS + STROKE / 2 + 4.5);
  return <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="var(--muted)" strokeWidth="1.5" />;
}

export interface GaugeProps {
  /** The reading, in the same unit as `max`. Null or undefined draws the no-data state. */
  value: number | null | undefined;
  max?: number;
  /** What is being measured. Becomes the meter's accessible name. */
  label: string;
  /** Printed under the ring when on. Off by default, for places that name the gauge themselves. */
  showLabel?: boolean;
  thresholds?: Thresholds;
  size?: GaugeSize;
  /** The centre text, in the mono font. Defaults to the percentage of `max`. */
  display?: string;
  /** The reading in words, for assistive technology and the tooltip: "3.2 GB of 8 GB". Defaults to `display`. */
  valueText?: string;
  className?: string;
}

/**
 * A ring gauge echoing the logo. A reading past a scale mark changes the arc's colour, and past the
 * last one a failed lamp appears, so the level still reads without colour.
 */
export function Gauge({
  value,
  max = 100,
  label,
  showLabel = false,
  thresholds = defaultThresholds,
  size = "md",
  display,
  valueText,
  className,
}: GaugeProps) {
  const { t } = useTranslation("visual");
  const reading = readQuantity(value, max, thresholds);
  const { pixels, text, textLong, scale } = sizes[size];

  const noData = t("quantity.noData");
  const center = reading === null ? "–" : (display ?? reading.percent);
  const spokenValue = reading === null ? noData : (valueText ?? center);
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
    <span className={cn("inline-flex flex-col items-center gap-1.5", className)}>
      <span
        {...roles}
        title={`${label}: ${spokenValue}`}
        className="relative inline-flex shrink-0 items-center justify-center"
        style={{ width: pixels, height: pixels }}
      >
        <svg
          viewBox="0 0 100 100"
          width={pixels}
          height={pixels}
          className="absolute inset-0"
          aria-hidden="true"
        >
          <g fill="none" strokeWidth={STROKE} transform={`rotate(-90 ${CENTER} ${CENTER})`}>
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              stroke={reading === null ? "var(--off)" : "var(--track)"}
              strokeWidth={reading === null ? 3 : undefined}
              pathLength={reading === null ? 72 : undefined}
              strokeDasharray={reading === null ? "2 2" : undefined}
            />
            {reading !== null && (
              <circle
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                stroke={levelColor[reading.level]}
                pathLength={360}
                strokeDasharray={`${gaugeSweep(reading.fraction)} 360`}
                strokeDashoffset={-TICK_HALF_ANGLE}
              />
            )}
            {reading !== null && (
              <circle
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                stroke="var(--highlight)"
                pathLength={360}
                strokeDasharray={`${2 * TICK_HALF_ANGLE} 360`}
                strokeDashoffset={TICK_HALF_ANGLE}
              />
            )}
          </g>
          {reading !== null && scale && (
            <>
              <ScaleMark fraction={thresholds.busy} />
              <ScaleMark fraction={thresholds.bad} />
            </>
          )}
        </svg>
        <span
          className={cn(
            "relative font-mono leading-none tabular-nums",
            center.length > 5 ? textLong : text,
            reading === null && "text-muted",
          )}
        >
          {center}
        </span>
        {reading?.level === "bad" && scale && (
          <Lamp state="failed" size="xs" still decorative className="absolute top-[22%]" />
        )}
      </span>
      {showLabel && (
        <span className="text-xs text-muted" aria-hidden="true">
          {label}
        </span>
      )}
    </span>
  );
}
