import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { defaultThresholds, levelColor, levelOf, type Thresholds } from "./quantity";
import "./strings";

const PADDING = 3;

export interface SparklineGeometry {
  /** One path per unbroken run of samples. A missing sample leaves a gap rather than a false line. */
  paths: string[];
  /** The most recent sample, where the end dot goes. Null when there is no data at all. */
  last: { x: number; y: number; value: number } | null;
}

const isSample = (value: number | null): value is number => value !== null && Number.isFinite(value);

export function sparklineGeometry(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
  max?: number,
): SparklineGeometry {
  const samples = values.filter(isSample);
  if (samples.length === 0) {
    return { paths: [], last: null };
  }

  const low = max === undefined ? Math.min(...samples) : 0;
  const high = max === undefined ? Math.max(...samples) : max;
  const range = high - low || 1;
  const step = values.length > 1 ? (width - 2 * PADDING) / (values.length - 1) : 0;
  const position = (value: number, index: number) => ({
    x: PADDING + index * step,
    y: height - PADDING - ((Math.min(Math.max(value, low), high) - low) / range) * (height - 2 * PADDING),
  });

  const paths: string[] = [];
  let run: string[] = [];
  let last: SparklineGeometry["last"] = null;
  const flush = () => {
    if (run.length > 1) {
      paths.push(`M${run.join("L")}`);
    }
    run = [];
  };

  values.forEach((value, index) => {
    if (!isSample(value)) {
      flush();
      return;
    }
    const point = position(value, index);
    run.push(`${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
    last = { ...point, value };
  });
  flush();

  return { paths, last };
}

export interface SparklineProps {
  /** Samples oldest first. Null marks a sample that is missing. */
  values: ReadonlyArray<number | null>;
  /** What the trend is of, such as "CPU, last hour". */
  label: string;
  /** The latest value in words, for assistive technology and the tooltip. */
  valueText?: string;
  /** A fixed top of the scale. Without it the line fills the height and the end dot stays neutral. */
  max?: number;
  thresholds?: Thresholds;
  width?: number;
  height?: number;
  className?: string;
}

/** A trend in a few centimetres: thin line, one dot for now. The dot takes the level's colour when `max` is known. */
export function Sparkline({
  values,
  label,
  valueText,
  max,
  thresholds = defaultThresholds,
  width = 120,
  height = 30,
  className,
}: SparklineProps) {
  const { t } = useTranslation("visual");
  const { paths, last } = sparklineGeometry(values, width, height, max);
  const spokenValue = last === null ? t("quantity.noData") : valueText;
  const name = spokenValue === undefined ? label : `${label}: ${spokenValue}`;
  const dotColor =
    last !== null && max !== undefined && max > 0
      ? levelColor[levelOf(last.value / max, thresholds)]
      : "var(--ink)";

  return (
    <span title={name} className={cn("inline-flex shrink-0", className)}>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={name}>
        {last === null ? (
          <line
            x1={PADDING}
            y1={height / 2}
            x2={width - PADDING}
            y2={height / 2}
            stroke="var(--off)"
            strokeWidth="1.5"
            strokeDasharray="4 3"
          />
        ) : (
          <>
            {paths.map((path) => (
              <path
                key={path}
                d={path}
                fill="none"
                stroke="var(--muted)"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            ))}
            <circle cx={last.x} cy={last.y} r="2.5" fill={dotColor} />
          </>
        )}
      </svg>
    </span>
  );
}
