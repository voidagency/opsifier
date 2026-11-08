import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { type LampStatus, StatusLamp } from "../../StatusLamp";
import { contrastRatio, MIN_INDICATOR_CONTRAST, MIN_TEXT_CONTRAST } from "../contrast";
import { Gauge } from "../Gauge";
import { GaugeBar } from "../GaugeBar";
import { HealthSummary } from "../HealthSummary";
import { Illustration, illustrationNames } from "../Illustration";
import { Lamp, type LampSize, lampSizes } from "../Lamp";
import { Pictogram, type PictogramName } from "../Pictogram";
import {
  builderPictograms,
  conceptPictograms,
  resourcePictograms,
  servicePictograms,
  sourcePictograms,
} from "../pictograms";
import { Sparkline } from "../Sparkline";
import {
  countStates,
  type HealthCounts,
  stateFromLamp,
  stateLanguage,
  type VisualState,
  visualStates,
} from "../state";

const lampSizeNames = Object.keys(lampSizes) as LampSize[];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="border-t pt-5">
      <h2 className="mb-4 text-lg font-medium">{title}</h2>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="eyebrow mb-2">{children}</p>;
}

function StateTable() {
  const [replay, setReplay] = useState(0);
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="eyebrow border-b text-left">
              <th className="py-2 pr-4 font-medium">State</th>
              <th className="py-2 pr-4 font-medium">Lamp: xs sm md lg xl</th>
              <th className="py-2 pr-4 font-medium">Named</th>
              <th className="py-2 pr-4 font-medium">Colour</th>
              <th className="py-2 pr-4 font-medium">Shape</th>
              <th className="py-2 pr-4 font-medium">Motion</th>
              <th className="py-2 font-medium">Problem</th>
            </tr>
          </thead>
          <tbody>
            {visualStates.map((state) => {
              const definition = stateLanguage[state];
              return (
                <tr key={state} className="border-b">
                  <td className="py-2 pr-4">{state}</td>
                  <td className="py-2 pr-4">
                    <span key={replay} className="inline-flex items-center gap-3">
                      {lampSizeNames.map((size) => (
                        <Lamp key={size} state={state} size={size} />
                      ))}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <Lamp state={state} size="sm" showLabel still />
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{definition.color.slice(4, -1)}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{definition.shape}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{definition.motion}</td>
                  <td className="py-2 font-mono text-xs">{definition.problem ? "yes" : "no"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={() => setReplay((value) => value + 1)}
        className="mt-3 h-7 cursor-pointer rounded-sm border border-off px-2.5 text-xs hover:bg-wash"
      >
        Replay motion
      </button>

      <div className="mt-6 grid gap-6 md:grid-cols-3">
        <div>
          <Label>Without colour: shape alone</Label>
          <div className="flex items-center gap-4" style={{ filter: "grayscale(1)" }}>
            {visualStates.map((state) => (
              <Lamp key={state} state={state} size="lg" still />
            ))}
          </div>
        </div>
        <div>
          <Label>On the navy top bar</Label>
          <div className="brand-bar flex items-center gap-4 rounded-sm px-3 py-2">
            {visualStates.map((state) => (
              <Lamp key={state} state={state} size="lg" still />
            ))}
          </div>
        </div>
        <div>
          <Label>Existing StatusLamp, with its Lamp</Label>
          <div className="flex items-center gap-5">
            {(["ok", "busy", "off", "bad"] as LampStatus[]).map((status) => (
              <span key={status} className="inline-flex items-center gap-1.5">
                <StatusLamp status={status} label={status} />
                <Lamp state={stateFromLamp(status)} size="sm" />
              </span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

const gauges = [
  { label: "CPU", value: 24 },
  { label: "Memory", value: 78 },
  { label: "Disk", value: 95 },
  { label: "Network", value: null },
];

function Quantities() {
  const trend = [12, 18, 14, 22, 30, 26, 34, 40, 37, 44, 52, 48, 55, 58];
  const spiky = [20, 34, 28, 60, 72, 66, 84, 79, 91, 88, 94, 96];
  const gappy = [30, 34, null, null, 41, 38, 44, null, 52, 50];
  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end gap-8">
        {gauges.map((gauge) => (
          <Gauge key={gauge.label} value={gauge.value} label={gauge.label} size="lg" showLabel />
        ))}
        {gauges.map((gauge) => (
          <Gauge key={gauge.label} value={gauge.value} label={gauge.label} size="md" showLabel />
        ))}
        {gauges.map((gauge) => (
          <Gauge key={gauge.label} value={gauge.value} label={gauge.label} size="sm" showLabel />
        ))}
        <Gauge
          value={3.4}
          max={8}
          label="Memory"
          size="md"
          display="3.4 GB"
          valueText="3.4 GB of 8 GB"
          showLabel
        />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <Label>Compact bars</Label>
          <div className="grid max-w-md gap-2">
            {gauges.map((gauge) => (
              <div key={gauge.label} className="grid grid-cols-[72px_1fr] items-center gap-3 text-xs">
                <span>{gauge.label}</span>
                <GaugeBar value={gauge.value} label={gauge.label} />
              </div>
            ))}
          </div>
        </div>
        <div>
          <Label>Sparklines</Label>
          <div className="grid max-w-md gap-3 text-xs">
            <div className="grid grid-cols-[72px_auto_1fr] items-center gap-3">
              <span>Requests</span>
              <Sparkline values={trend} label="Requests, last hour" valueText="58" />
              <span className="font-mono text-muted">no scale</span>
            </div>
            <div className="grid grid-cols-[72px_auto_1fr] items-center gap-3">
              <span>CPU</span>
              <Sparkline values={spiky} max={100} label="CPU, last hour" valueText="96%" />
              <span className="font-mono text-muted">max 100, end dot follows thresholds</span>
            </div>
            <div className="grid grid-cols-[72px_auto_1fr] items-center gap-3">
              <span>Memory</span>
              <Sparkline values={gappy} max={100} label="Memory, last hour" valueText="50%" />
              <span className="font-mono text-muted">gaps stay gaps</span>
            </div>
            <div className="grid grid-cols-[72px_auto_1fr] items-center gap-3">
              <span>Disk</span>
              <Sparkline values={[]} label="Disk, last hour" />
              <span className="font-mono text-muted">no data</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const services: ReadonlyArray<{ name: string; state: VisualState }> = [
  { name: "web", state: "running" },
  { name: "api", state: "failed" },
  { name: "worker", state: "progress" },
  { name: "postgres", state: "running" },
  { name: "cache", state: "degraded" },
  { name: "mailer", state: "stopped" },
  { name: "cron", state: "unknown" },
  { name: "search", state: "running" },
];

const healthy: HealthCounts = { running: 12, stopped: 2 };

function Health() {
  const [selected, setSelected] = useState<VisualState | null>(null);
  const counts = countStates(services.map((service) => service.state));
  const shown = selected === null ? services : services.filter((service) => service.state === selected);
  return (
    <div className="grid gap-8">
      <div>
        <Label>Strip, opens a page. Each count filters the list below</Label>
        <HealthSummary counts={counts} selected={selected} onSelect={setSelected} />
        <ul className="mt-2 max-w-sm">
          {shown.map((service) => (
            <li key={service.name} className="flex items-center gap-3 border-b py-1.5">
              <Lamp state={service.state} size="sm" still />
              <span className="font-mono text-xs">{service.name}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <Label>Row, for headers</Label>
        <div className="flex items-center justify-between border-b pb-2">
          <span className="font-medium">Project: shop</span>
          <HealthSummary counts={counts} selected={selected} onSelect={setSelected} variant="row" />
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <Label>All clear</Label>
          <HealthSummary counts={healthy} />
        </div>
        <div>
          <Label>Nothing yet</Label>
          <HealthSummary counts={{}} />
        </div>
      </div>
    </div>
  );
}

const pictogramGroups: ReadonlyArray<{ title: string; names: string[] }> = [
  { title: "Service types", names: Object.keys(servicePictograms) },
  { title: "Sources", names: Object.keys(sourcePictograms) },
  { title: "Builders", names: ["dockerfile", ...Object.keys(builderPictograms)] },
  { title: "Resources", names: Object.keys(resourcePictograms) },
  { title: "Concepts", names: Object.keys(conceptPictograms) },
];

function Pictograms() {
  return (
    <div className="grid gap-6">
      {pictogramGroups.map((group) => (
        <div key={group.title}>
          <Label>{group.title}</Label>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] border-t border-l">
            {group.names.map((name) => (
              <div key={name} className="border-r border-b px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <Pictogram name={name as PictogramName} size={16} />
                  <Pictogram name={name as PictogramName} size={20} />
                  <Pictogram name={name as PictogramName} size={24} />
                </div>
                <div
                  className="mt-1.5 flex items-center gap-3 text-muted"
                  style={{ "--highlight": "transparent" } as CSSProperties}
                >
                  <Pictogram name={name as PictogramName} size={16} />
                  <Pictogram name={name as PictogramName} size={20} />
                  <Pictogram name={name as PictogramName} size={24} />
                </div>
                <p className="mt-1.5 font-mono text-micro text-muted">{name}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted">
        Second line of each cell: the same pictogram with amber removed, in the muted ink. It must still read.
      </p>
    </div>
  );
}

function Illustrations() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-6">
      {illustrationNames.map((name) => (
        <figure key={name} className="m-0">
          <Illustration name={name} size={180} />
          <figcaption className="mt-2 font-mono text-xs text-muted">{name}</figcaption>
        </figure>
      ))}
    </div>
  );
}

interface ContrastRow {
  name: string;
  surface: string;
  foreground: string;
  background: string;
  ratio: number;
  minimum: number;
}

const indicators = visualStates.map((state) => `--state-${state}`);

function readToken(element: HTMLElement, token: string): string {
  return getComputedStyle(element).getPropertyValue(token).trim();
}

function measure(element: HTMLElement, tokens: string[], minimum: number, surfaces: string[]): ContrastRow[] {
  return tokens.flatMap((token) =>
    surfaces.map((surface) => {
      const foreground = readToken(element, token);
      const background = readToken(element, surface);
      return {
        name: token,
        surface,
        foreground,
        background,
        ratio: contrastRatio(foreground, background),
        minimum,
      };
    }),
  );
}

function Contrast() {
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<ContrastRow[]>([]);

  useEffect(() => {
    if (root.current === null || bar.current === null) {
      return;
    }
    setRows([
      ...measure(root.current, indicators, MIN_INDICATOR_CONTRAST, ["--bg", "--raised", "--track"]),
      ...measure(root.current, ["--ink", "--muted"], MIN_TEXT_CONTRAST, ["--bg", "--raised"]),
      ...measure(bar.current, indicators, MIN_INDICATOR_CONTRAST, ["--bg", "--raised"]).map((row) => ({
        ...row,
        surface: `top bar ${row.surface}`,
      })),
    ]);
  }, []);

  return (
    <div ref={root}>
      <div ref={bar} className="brand-bar hidden" />
      <div className="overflow-x-auto">
        <table className="w-full max-w-3xl text-xs">
          <thead>
            <tr className="eyebrow border-b text-left">
              <th className="py-2 pr-4 font-medium" />
              <th className="py-2 pr-4 font-medium">Token</th>
              <th className="py-2 pr-4 font-medium">On</th>
              <th className="py-2 pr-4 font-medium">Colours</th>
              <th className="py-2 pr-4 text-right font-medium">Ratio</th>
              <th className="py-2 text-right font-medium">Need</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.name}-${row.surface}`} className="border-b">
                <td className="py-1 pr-4">
                  <Lamp state={row.ratio >= row.minimum ? "running" : "failed"} size="sm" still />
                </td>
                <td className="py-1 pr-4 font-mono">{row.name}</td>
                <td className="py-1 pr-4 font-mono">{row.surface}</td>
                <td className="py-1 pr-4 font-mono text-muted">
                  {row.foreground} on {row.background}
                </td>
                <td className="py-1 pr-4 text-right font-mono">{row.ratio.toFixed(2)}</td>
                <td className="py-1 text-right font-mono">{row.minimum}:1</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Everything in the visual language, in the theme set on the document. */
export function Gallery() {
  const theme = document.documentElement.dataset.theme ?? "light";
  return (
    <main className="mx-auto grid max-w-[1200px] gap-10 px-6 py-8">
      <header>
        <h1 className="text-xl font-medium">Visual language</h1>
        <p className="mt-1 text-muted">
          <span className="font-mono">{theme}</span> theme. Development only.
        </p>
      </header>
      <Section id="states" title="State language">
        <StateTable />
      </Section>
      <Section id="quantities" title="Quantities">
        <Quantities />
      </Section>
      <Section id="health" title="Health at a glance">
        <Health />
      </Section>
      <Section id="pictograms" title="Pictograms">
        <Pictograms />
      </Section>
      <Section id="illustrations" title="Illustrations">
        <Illustrations />
      </Section>
      <Section id="contrast" title="Contrast">
        <Contrast />
      </Section>
    </main>
  );
}

function ThemeFrame({ theme }: { theme: "light" | "dark" }) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const element = frame.current;
    if (element === null) {
      return;
    }
    let observer: ResizeObserver | undefined;
    const follow = () => {
      const content = element.contentDocument?.documentElement;
      if (content === undefined) {
        return;
      }
      const resize = () => {
        element.style.height = `${content.scrollHeight}px`;
      };
      observer?.disconnect();
      observer = new ResizeObserver(resize);
      observer.observe(content);
      resize();
    };
    element.addEventListener("load", follow);
    return () => {
      element.removeEventListener("load", follow);
      observer?.disconnect();
    };
  }, []);

  return (
    <iframe ref={frame} title={`${theme} theme`} src={`?theme=${theme}`} className="block w-full border-0" />
  );
}

/** Both themes side by side, one scrollbar. A frame each, because `data-theme` lives on the document. */
export function BothThemes() {
  return (
    <div className="grid min-w-[1100px] grid-cols-2">
      <ThemeFrame theme="light" />
      <ThemeFrame theme="dark" />
    </div>
  );
}
