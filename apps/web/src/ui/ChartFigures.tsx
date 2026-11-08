import type { ReactNode } from "react";

const hairline = "var(--rule)";
const ink = "var(--muted)";
const signal = "var(--highlight)";

function Figure({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 960 220"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      className="block size-full"
      fill="none"
      strokeWidth="1"
    >
      {children}
    </svg>
  );
}

function Graticule() {
  const verticals = [96, 192, 288, 384, 480, 576, 672, 768, 864];
  const horizontals = [55, 110, 165];
  return (
    <g stroke={hairline} strokeWidth="0.5" strokeDasharray="1 5">
      {verticals.map((x) => (
        <line key={x} x1={x} y1="0" x2={x} y2="220" />
      ))}
      {horizontals.map((y) => (
        <line key={y} x1="0" y1={y} x2="960" y2={y} />
      ))}
    </g>
  );
}

function Soundings({ points }: { points: ReadonlyArray<readonly [number, number, string]> }) {
  return (
    <g fill={ink} fontSize="10" opacity="0.72" style={{ fontFamily: "var(--font-mono)" }}>
      {points.map(([x, y, depth]) => (
        <text key={`${x}-${y}`} x={x} y={y}>
          {depth}
        </text>
      ))}
    </g>
  );
}

const coastPath = "M-10 44C120 24 208 66 322 54S524 24 642 48 842 76 970 44";

/** A quiet harbour with a vacant berth. */
export function HarbourFigure() {
  return (
    <Figure>
      <Graticule />
      {[22, 48, 78, 112].map((offset) => (
        <path key={offset} d={coastPath} transform={`translate(0 ${offset})`} stroke={hairline} />
      ))}
      <path d={`${coastPath}V-10H-10Z`} fill="var(--bg)" stroke={ink} />
      <path d="M636 48 650 112 718 130" stroke={ink} strokeWidth="1.5" strokeLinecap="round" />
      <Soundings
        points={[
          [84, 104, "12"],
          [168, 136, "18"],
          [252, 100, "9"],
          [344, 152, "24"],
          [448, 112, "15"],
          [530, 178, "31"],
          [736, 176, "27"],
          [828, 118, "19"],
          [902, 168, "36"],
          [60, 182, "22"],
          [284, 194, "28"],
          [612, 204, "33"],
        ]}
      />
      <circle cx="588" cy="118" r="30" stroke={signal} strokeDasharray="2 4" opacity="0.8" />
      <circle cx="588" cy="118" r="4.5" fill={signal} />
    </Figure>
  );
}

/** An empty timeline, its wake still to be written. */
export function WakeFigure() {
  const count = 24;
  const start = 72;
  const gap = (960 - 2 * start) / (count - 1);
  return (
    <Figure>
      <Graticule />
      <path d="M-10 40C150 22 300 58 470 42S780 22 970 44" stroke={hairline} />
      <path d="M-10 66C150 48 300 84 470 68S780 48 970 70" stroke={hairline} />
      <line x1={start - 24} y1="160" x2={960 - start + 24} y2="160" stroke={ink} />
      {Array.from({ length: count }, (_, index) => {
        const x = start + index * gap;
        const height = 18 + (46 * index) / (count - 1);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decoration
          <g key={index}>
            <rect x={x - 5} y={156 - height} width="10" height={height} rx="1" stroke={ink} opacity="0.5" />
            <line x1={x} y1="160" x2={x} y2={index % 6 === 0 ? "170" : "165"} stroke={ink} />
          </g>
        );
      })}
      <g fill={ink} fontSize="10" opacity="0.72" style={{ fontFamily: "var(--font-mono)" }}>
        {[0, 6, 12, 18].map((tick) => (
          <text key={tick} x={start + tick * gap} y="186" textAnchor="middle">
            {`-${24 - tick}`}
          </text>
        ))}
      </g>
      <path d={`M${960 - start} 168l-6 9h12z`} fill={signal} />
      <line x1={960 - start} y1="92" x2={960 - start} y2="160" stroke={signal} />
    </Figure>
  );
}

function Dial({ cx, label }: { cx: number; label: string }) {
  const cy = 128;
  const radius = 78;
  const startAngle = 150;
  const sweep = 240;
  const ticks = 24;
  const pointAt = (angle: number, r: number) => {
    const radians = (angle * Math.PI) / 180;
    return [cx + r * Math.cos(radians), cy + r * Math.sin(radians)] as const;
  };
  const [needleX, needleY] = pointAt(startAngle, radius - 12);
  return (
    <g>
      {Array.from({ length: ticks + 1 }, (_, index) => {
        const angle = startAngle + (sweep * index) / ticks;
        const major = index % 6 === 0;
        const [x1, y1] = pointAt(angle, radius);
        const [x2, y2] = pointAt(angle, radius - (major ? 11 : 6));
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decoration
          <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} stroke={ink} opacity={major ? 1 : 0.45} />
        );
      })}
      <line
        x1={cx}
        y1={cy}
        x2={needleX}
        y2={needleY}
        stroke={signal}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx={cx} cy={cy} r="3.5" fill={signal} />
      <text
        x={cx}
        y={cy + 58}
        textAnchor="middle"
        fill={ink}
        fontSize="11"
        opacity="0.8"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {label}
      </text>
    </g>
  );
}

/** Three instruments at rest. */
export function InstrumentFigure() {
  return (
    <Figure>
      <Graticule />
      <Dial cx={200} label="0.0" />
      <Dial cx={480} label="0.0" />
      <Dial cx={760} label="0.0" />
    </Figure>
  );
}

/** A light's sectors marking a channel into harbour. */
export function ApproachFigure() {
  const x = 90;
  const y = 112;
  const bearings = [-16, -7, 0, 7, 16];
  const reach = 960;
  return (
    <Figure>
      <Graticule />
      <path d="M-10 26C60 30 100 62 88 112S60 196 -10 206V-10H-10Z" fill="var(--bg)" stroke={ink} />
      {bearings.map((angle) => {
        const radians = (angle * Math.PI) / 180;
        return (
          <line
            key={angle}
            x1={x}
            y1={y}
            x2={x + reach * Math.cos(radians)}
            y2={y + reach * Math.sin(radians)}
            stroke={angle === 0 ? signal : hairline}
            strokeDasharray={angle === 0 ? "6 4" : undefined}
          />
        );
      })}
      {[230, 430, 640, 850].map((radius) => (
        <path
          key={radius}
          d={`M${x + radius * Math.cos(-0.34)} ${y + radius * Math.sin(-0.34)}A${radius} ${radius} 0 0 1 ${
            x + radius * Math.cos(0.34)
          } ${y + radius * Math.sin(0.34)}`}
          stroke={hairline}
        />
      ))}
      <g fill={ink} fontSize="10" opacity="0.72" style={{ fontFamily: "var(--font-mono)" }}>
        <text x={x + 438} y={y - 10}>
          090°
        </text>
        <text x={x + 640} y={y - 86}>
          076°
        </text>
        <text x={x + 640} y={y + 92}>
          104°
        </text>
      </g>
      <circle cx={x} cy={y} r="5" fill={signal} />
      <circle cx={x} cy={y} r="11" stroke={signal} opacity="0.6" />
    </Figure>
  );
}

const sheetCoast = "M812 -12C724 92 672 160 688 280S604 472 640 612 742 808 636 1012";

/** The full chart sheet behind the sign-in screens. */
export function ChartSheet() {
  const contours = [
    { dx: -46, dy: 12 },
    { dx: -104, dy: 22 },
    { dx: -176, dy: 8 },
    { dx: -264, dy: -6 },
    { dx: -372, dy: 18 },
  ];
  const lat = [120, 280, 440, 600, 760, 920];
  const long = [100, 260, 420, 580, 740];

  const soundings: ReadonlyArray<readonly [number, number, string]> = [
    [86, 96, "47"],
    [214, 158, "38"],
    [360, 108, "29"],
    [492, 196, "22"],
    [582, 92, "14"],
    [148, 268, "52"],
    [302, 324, "41"],
    [440, 274, "33"],
    [538, 356, "18"],
    [70, 412, "60"],
    [226, 470, "55"],
    [388, 438, "36"],
    [506, 498, "21"],
    [120, 584, "63"],
    [286, 632, "58"],
    [430, 590, "37"],
    [552, 650, "16"],
    [74, 752, "71"],
    [238, 806, "62"],
    [404, 766, "39"],
    [526, 838, "19"],
    [612, 748, "11"],
    [160, 908, "68"],
    [346, 932, "44"],
    [500, 954, "23"],
  ];

  return (
    <svg
      viewBox="0 0 800 1000"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      className="block size-full"
      fill="none"
    >
      <g stroke={hairline} strokeWidth="0.75" strokeDasharray="1 6">
        {lat.map((y) => (
          <line key={y} x1="0" y1={y} x2="800" y2={y} />
        ))}
        {long.map((x) => (
          <line key={x} x1={x} y1="0" x2={x} y2="1000" />
        ))}
      </g>

      {contours.map(({ dx, dy }) => (
        <path
          key={dx}
          d={sheetCoast}
          transform={`translate(${dx} ${dy})`}
          stroke={hairline}
          strokeWidth="1"
        />
      ))}

      <path d="M730 290 618 334 590 330" stroke={ink} strokeWidth="3" strokeLinecap="round" />
      <path d={`${sheetCoast}H812V-12Z`} fill="var(--bg)" stroke={ink} strokeWidth="1" />

      <path d="M592 338 410 590 298 770" stroke={signal} strokeWidth="1.25" strokeDasharray="7 5" />
      <circle cx="592" cy="338" r="5" fill={signal} />
      <circle cx="592" cy="338" r="13" stroke={signal} opacity="0.55" />
      <circle cx="298" cy="770" r="3" fill={signal} />

      <Soundings points={soundings} />

      <g transform="translate(176 172)" stroke={ink}>
        <circle r="52" strokeWidth="0.75" />
        <circle r="36" stroke={hairline} strokeWidth="0.75" />
        {Array.from({ length: 36 }, (_, index) => {
          const radians = (index * 10 * Math.PI) / 180;
          const inner = index % 9 === 0 ? 44 : 48;
          return (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decoration
              key={index}
              x1={inner * Math.cos(radians)}
              y1={inner * Math.sin(radians)}
              x2={52 * Math.cos(radians)}
              y2={52 * Math.sin(radians)}
              strokeWidth="0.75"
            />
          );
        })}
        <path d="M0 -40 5.5 6 0 2 -5.5 6Z" fill={signal} stroke="none" />
      </g>

      <g transform="translate(476 940)" stroke={ink}>
        {[0, 40, 80, 120, 160].map((x, index) => (
          <rect
            key={x}
            x={x}
            y="0"
            width="40"
            height="7"
            fill={index % 2 === 0 ? ink : "none"}
            strokeWidth="0.75"
          />
        ))}
        <g fill={ink} fontSize="11" stroke="none" style={{ fontFamily: "var(--font-mono)" }}>
          <text x="0" y="-6">
            0
          </text>
          <text x="154" y="-6">
            1 nm
          </text>
        </g>
      </g>
    </svg>
  );
}
