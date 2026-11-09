import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";

export interface TrendPoint {
  at: string;
  value: number | null;
}

interface TrendLineProps {
  points: readonly TrendPoint[];
  /** What the line is of. Becomes the chart's accessible name. */
  label: string;
  /** A fixed top of the scale. Without one the line fills the height. */
  max?: number;
  format: (value: number) => string;
  className?: string;
}

const WIDTH = 240;
const HEIGHT = 56;
const PADDING = 4;

interface Geometry {
  paths: string[];
  positions: Array<{ x: number; y: number; point: TrendPoint; value: number }>;
}

function layout(points: readonly TrendPoint[], max: number | undefined): Geometry {
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  if (values.length === 0) {
    return { paths: [], positions: [] };
  }
  const top = max ?? Math.max(...values, 1);
  const step = points.length > 1 ? (WIDTH - 2 * PADDING) / (points.length - 1) : 0;
  const paths: string[] = [];
  const positions: Geometry["positions"] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) {
      paths.push(`M${run.join("L")}`);
    }
    run = [];
  };
  points.forEach((point, index) => {
    if (point.value === null) {
      flush();
      return;
    }
    const x = PADDING + index * step;
    const y = HEIGHT - PADDING - (Math.min(point.value, top) / top) * (HEIGHT - 2 * PADDING);
    run.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
    positions.push({ x, y, point, value: point.value });
  });
  flush();
  return { paths, positions };
}

/** A trend with a time behind every point: the line scales to its box, and hovering shows the moment. */
export function TrendLine({ points, label, max, format, className }: TrendLineProps) {
  const { t, i18n } = useTranslation("monitor");
  const geometry = useMemo(() => layout(points, max), [points, max]);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  if (geometry.positions.length === 0) {
    return (
      <div
        role="img"
        aria-label={`${label}: ${t("chart.noData")}`}
        className={cn("flex h-14 items-center text-xs text-muted", className)}
      >
        <span
          aria-hidden="true"
          className="block h-0.5 w-full"
          style={{
            backgroundImage: "repeating-linear-gradient(90deg, var(--off) 0 4px, transparent 4px 7px)",
          }}
        />
      </div>
    );
  }

  const shown = hover === null ? null : geometry.positions[hover];
  const latest = geometry.positions.at(-1);
  const summary = latest === undefined ? "" : `${label}: ${format(latest.value)}`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the values are available through the accessible name; hovering is only a closer look
    <div
      ref={box}
      className={cn("relative", className)}
      onMouseLeave={() => setHover(null)}
      onMouseMove={(event) => {
        const rect = box.current?.getBoundingClientRect();
        if (rect === undefined || rect.width === 0) {
          return;
        }
        const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
        let nearest = 0;
        let distance = Number.POSITIVE_INFINITY;
        geometry.positions.forEach((position, index) => {
          const gap = Math.abs(position.x - x);
          if (gap < distance) {
            distance = gap;
            nearest = index;
          }
        });
        setHover(nearest);
      }}
    >
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="block h-14 w-full"
        role="img"
        aria-label={summary}
      >
        <title>{summary}</title>
        {geometry.paths.map((path) => (
          <path
            key={path}
            d={path}
            fill="none"
            stroke="var(--muted)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {shown !== null && shown !== undefined && (
          <line
            x1={shown.x}
            x2={shown.x}
            y1={0}
            y2={HEIGHT}
            stroke="var(--accent)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {shown !== null && shown !== undefined && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-y-full rounded-sm bg-ink px-2 py-1 font-mono text-xs whitespace-nowrap text-bg"
          style={
            shown.x > WIDTH / 2
              ? { right: `${100 - (shown.x / WIDTH) * 100}%` }
              : { left: `${(shown.x / WIDTH) * 100}%` }
          }
        >
          {format(shown.value)}
          <span className="ml-2 opacity-70">{formatDateTime(shown.point.at, i18n.language)}</span>
        </div>
      )}
    </div>
  );
}
