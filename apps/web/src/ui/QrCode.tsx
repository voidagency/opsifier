import { useMemo } from "react";
import { encodeQr } from "../lib/qr";

const quietZone = 4;

export interface QrCodeProps {
  value: string;
  /** Describes what the code is for. */
  label: string;
  size?: number;
}

/** Always dark on light, in both themes: phone cameras read inverted codes badly. */
export function QrCode({ value, label, size = 184 }: QrCodeProps) {
  const { path, dimension } = useMemo(() => {
    const matrix = encodeQr(value);
    let d = "";
    matrix.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (!row[x]) {
          x++;
          continue;
        }
        let width = 1;
        while (row[x + width]) {
          width++;
        }
        d += `M${x + quietZone} ${y + quietZone}h${width}v1h-${width}z`;
        x += width;
      }
    });
    return { path: d, dimension: matrix.length + quietZone * 2 };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${dimension} ${dimension}`}
      shapeRendering="crispEdges"
      className="block rounded-sm border bg-[#ffffff]"
    >
      <path d={path} fill="#16264a" />
    </svg>
  );
}
