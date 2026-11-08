// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { Gauge, gaugeSweep } from "./Gauge";
import { GaugeBar } from "./GaugeBar";
import { HealthSummary } from "./HealthSummary";
import { Illustration, illustrationNames } from "./Illustration";
import { Lamp, lampSizes } from "./Lamp";
import { isPictogramName, Pictogram, pictogramNames } from "./Pictogram";
import { defaultThresholds, readQuantity } from "./quantity";
import { Sparkline, sparklineGeometry } from "./Sparkline";
import { stateLanguage, type VisualState, visualStates } from "./state";

afterEach(cleanup);

describe("Lamp", () => {
  it.each(visualStates)("names %s after its state by default", (state) => {
    render(<Lamp state={state} />);
    expect(
      screen.getByRole("img", { name: i18n.t(stateLanguage[state].labelKey, { ns: "visual" }) }),
    ).toBeTruthy();
  });

  it("takes a more precise name", () => {
    render(<Lamp state="failed" label="web: failed" />);
    expect(screen.getByRole("img", { name: "web: failed" })).toBeTruthy();
  });

  it("prints the name as text when asked and hides the lamp from assistive technology", () => {
    render(<Lamp state="running" showLabel />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("is hidden from assistive technology when a parent carries the name", () => {
    const { container } = render(<Lamp state="running" decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("takes its size from the scale", () => {
    const { container } = render(<Lamp state="running" size="lg" />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe(String(lampSizes.lg));
  });

  it.each(visualStates)("draws %s in its own colour", (state) => {
    const { container } = render(<Lamp state={state} />);
    expect((container.querySelector("svg") as SVGElement).style.color).toBe(stateLanguage[state].color);
  });

  it("moves only when the state language says so, and not when held still", () => {
    const { container, rerender } = render(<Lamp state="progress" />);
    expect(container.querySelector(".animate-lamp-turn")).toBeTruthy();
    rerender(<Lamp state="progress" still />);
    expect(container.querySelector(".animate-lamp-turn")).toBeNull();
    rerender(<Lamp state="failed" />);
    expect(container.querySelector(".animate-lamp-alarm")).toBeTruthy();
    rerender(<Lamp state="running" />);
    expect(container.querySelector("[class*='animate-']")).toBeNull();
  });
});

describe("readQuantity", () => {
  it("levels a reading against the thresholds", () => {
    expect(readQuantity(10, 100, defaultThresholds)?.level).toBe("ok");
    expect(readQuantity(70, 100, defaultThresholds)?.level).toBe("busy");
    expect(readQuantity(90, 100, defaultThresholds)?.level).toBe("bad");
  });

  it("clamps out-of-range readings", () => {
    expect(readQuantity(140, 100, defaultThresholds)).toMatchObject({
      value: 100,
      fraction: 1,
      percent: "100%",
    });
    expect(readQuantity(-3, 100, defaultThresholds)).toMatchObject({ value: 0, percent: "0%" });
  });

  it("has nothing to say about unusable numbers", () => {
    expect(readQuantity(null, 100, defaultThresholds)).toBeNull();
    expect(readQuantity(undefined, 100, defaultThresholds)).toBeNull();
    expect(readQuantity(Number.NaN, 100, defaultThresholds)).toBeNull();
    expect(readQuantity(5, 0, defaultThresholds)).toBeNull();
  });
});

describe("Gauge", () => {
  it("is a meter with an accessible name and value", () => {
    render(<Gauge value={3.2} max={8} label="Memory" display="3.2 GB" valueText="3.2 GB of 8 GB" />);
    const meter = screen.getByRole("meter", { name: "Memory" });
    expect(meter.getAttribute("aria-valuemin")).toBe("0");
    expect(meter.getAttribute("aria-valuemax")).toBe("8");
    expect(meter.getAttribute("aria-valuenow")).toBe("3.2");
    expect(meter.getAttribute("aria-valuetext")).toBe("3.2 GB of 8 GB");
    expect(screen.getByText("3.2 GB").className).toContain("font-mono");
  });

  it("defaults the centre value and the spoken value to the percentage", () => {
    render(<Gauge value={42} label="CPU" />);
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "CPU" }).getAttribute("aria-valuetext")).toBe("42%");
  });

  it("changes colour past each threshold, and shows a failed mark at the last one", () => {
    const stroke = (container: HTMLElement) =>
      container.querySelectorAll("circle")[1]?.getAttribute("stroke");
    const { container, rerender } = render(<Gauge value={20} label="CPU" />);
    expect(stroke(container)).toBe("var(--state-running)");
    expect(container.querySelector("[data-state='failed']")).toBeNull();
    rerender(<Gauge value={80} label="CPU" />);
    expect(stroke(container)).toBe("var(--state-progress)");
    rerender(<Gauge value={95} label="CPU" />);
    expect(stroke(container)).toBe("var(--state-failed)");
    expect(container.querySelector("[data-state='failed']")).toBeTruthy();
  });

  it("has a no-data state that is not a meter, since a meter needs a value", () => {
    render(<Gauge value={null} label="Network" />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByRole("img", { name: "Network: No data" })).toBeTruthy();
    expect(screen.getByText("–")).toBeTruthy();
  });

  it("fills the ring exactly at full capacity, stopping short of the tick", () => {
    expect(gaugeSweep(0)).toBe(0);
    expect(gaugeSweep(1)).toBeCloseTo(350.5, 5);
    expect(gaugeSweep(0.5)).toBeCloseTo(175.25, 5);
  });

  it("prints the caption without announcing it twice", () => {
    render(<Gauge value={10} label="Disk" showLabel />);
    expect(screen.getByText("Disk").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("meter", { name: "Disk" })).toBeTruthy();
  });
});

describe("GaugeBar", () => {
  it("is a meter", () => {
    render(<GaugeBar value={50} label="Disk" />);
    expect(screen.getByRole("meter", { name: "Disk" }).getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText("50%")).toBeTruthy();
  });

  it("draws no-data without a value", () => {
    render(<GaugeBar value={undefined} label="Disk" />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByRole("img", { name: "Disk: No data" })).toBeTruthy();
  });

  it("can drop the printed value", () => {
    render(<GaugeBar value={50} label="Disk" showValue={false} />);
    expect(screen.queryByText("50%")).toBeNull();
  });
});

describe("Sparkline", () => {
  it("is named with its latest value", () => {
    render(<Sparkline values={[1, 2, 3]} label="CPU, last hour" valueText="3%" />);
    expect(screen.getByRole("img", { name: "CPU, last hour: 3%" })).toBeTruthy();
  });

  it("says when there is no data", () => {
    render(<Sparkline values={[null, null]} label="Disk" />);
    expect(screen.getByRole("img", { name: "Disk: No data" })).toBeTruthy();
  });

  it("breaks the line at missing samples instead of drawing through them", () => {
    const { paths, last } = sparklineGeometry([1, 2, null, null, 4, 5], 100, 20);
    expect(paths).toHaveLength(2);
    expect(last?.value).toBe(5);
  });

  it("scales to a fixed maximum when given one", () => {
    const flat = sparklineGeometry([50, 50], 100, 20, 100);
    expect(flat.last?.y).toBeCloseTo(10, 5);
  });

  it("has nothing to draw without samples", () => {
    expect(sparklineGeometry([], 100, 20)).toEqual({ paths: [], last: null });
  });
});

const counts = { failed: 2, degraded: 1, running: 6, stopped: 0 };

function FilterHarness({ variant }: { variant?: "strip" | "row" }) {
  const [selected, setSelected] = useState<VisualState | null>(null);
  return (
    <>
      <HealthSummary counts={counts} selected={selected} onSelect={setSelected} variant={variant} />
      <output data-testid="selected">{selected ?? "none"}</output>
    </>
  );
}

describe("HealthSummary", () => {
  it("orders the counts problems first", () => {
    render(<FilterHarness />);
    const names = within(screen.getByRole("group"))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([
      "Failed: 2",
      "Degraded: 1",
      "Unknown: 0",
      "In progress: 0",
      "Running: 6",
      "Stopped: 0",
    ]);
  });

  it("names the group and summarises the problems", () => {
    render(<HealthSummary counts={counts} />);
    expect(screen.getByRole("group", { name: "Health summary" })).toBeTruthy();
    expect(screen.getByText("3 problems")).toBeTruthy();
  });

  it("says all clear when nothing is wrong, and nothing yet when empty", () => {
    const { rerender } = render(<HealthSummary counts={{ running: 3, stopped: 1 }} />);
    expect(screen.getByText("All clear")).toBeTruthy();
    rerender(<HealthSummary counts={{}} />);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
  });

  it("turns each count into a filter, and a second press clears it", () => {
    render(<FilterHarness />);
    const failed = screen.getByRole("button", { name: "Failed: 2" });
    expect(failed.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(failed);
    expect(failed.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("selected").textContent).toBe("failed");
    fireEvent.click(failed);
    expect(failed.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });

  it("does not offer a filter that would show nothing", () => {
    render(<FilterHarness />);
    expect((screen.getByRole("button", { name: "Stopped: 0" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a selected filter clearable after its count falls to zero", () => {
    const onSelect = vi.fn();
    render(<HealthSummary counts={{ running: 2 }} selected="failed" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Failed: 0" }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("shows plain named counts without a filter handler", () => {
    render(<HealthSummary counts={{ failed: 1, running: 4 }} variant="row" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("img", { name: "Failed: 1" })).toBeTruthy();
  });

  it("lists only what is there in the row form, problems first", () => {
    render(<FilterHarness variant="row" />);
    const names = within(screen.getByRole("group"))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["Failed: 2", "Degraded: 1", "Running: 6"]);
  });

  it("has a named state when the row has nothing to count", () => {
    render(<HealthSummary counts={{}} variant="row" />);
    expect(screen.getByRole("img", { name: "Nothing yet" })).toBeTruthy();
  });
});

describe("Pictogram", () => {
  it("covers every requested subject", () => {
    for (const name of [
      "app",
      "compose",
      "box",
      "wordpress",
      "postgres",
      "mysql",
      "mariadb",
      "mongo",
      "redis",
      "image",
      "git",
      "hosted-repository",
      "dockerfile",
      "upload",
      "buildpacks",
      "nixpacks",
      "railpack",
      "cpu",
      "memory",
      "disk",
      "network",
      "domain",
      "certificate",
      "port",
      "volume",
      "environment",
      "redirect",
      "access",
      "maintenance",
      "backup",
      "restore",
      "schedule",
      "console",
      "logs",
      "metrics",
      "deployment",
      "webhook",
      "notification",
      "user",
      "node",
      "template",
      "settings",
      "activity",
    ]) {
      expect(isPictogramName(name), name).toBe(true);
    }
  });

  describe.each(pictogramNames)("%s", (name) => {
    const drawn = () => {
      const { container } = render(<Pictogram name={name} size={24} />);
      return container.querySelector("svg") as SVGSVGElement;
    };

    it("sits on the one grid with the one stroke", () => {
      const svg = drawn();
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("stroke-width")).toBe("2");
      expect(svg.querySelector("[stroke-width]:not(svg)")).toBeNull();
    });

    it("uses exactly two tones", () => {
      const svg = drawn();
      const painted = [...svg.querySelectorAll("*")].flatMap((node) => [
        node.getAttribute("stroke"),
        node.getAttribute("fill"),
      ]);
      expect(painted).toContain("var(--highlight)");
      for (const paint of painted) {
        expect([null, "none", "currentColor", "var(--highlight)"]).toContain(paint);
      }
      expect(svg.getAttribute("stroke")).toBe("currentColor");
    });
  });

  it("is decorative unless given a name", () => {
    const { container, rerender } = render(<Pictogram name="postgres" />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    rerender(<Pictogram name="postgres" label="PostgreSQL" />);
    expect(screen.getByRole("img", { name: "PostgreSQL" })).toBeTruthy();
  });
});

describe("Illustration", () => {
  it.each(illustrationNames)("offers a light and a dark variant of %s", (name) => {
    const { container } = render(<Illustration name={name} />);
    const sources = [...container.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(sources).toEqual([`/illustrations/${name}-light.webp`, `/illustrations/${name}-dark.webp`]);
  });

  it("reserves its space before the image loads", () => {
    const { container } = render(<Illustration name="no-projects" size={160} />);
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.width).toBe("160px");
    expect(frame.style.height).toBe("160px");
    for (const image of container.querySelectorAll("img")) {
      expect(image.getAttribute("width")).toBe(image.getAttribute("height"));
      expect(image.getAttribute("loading")).toBe("lazy");
    }
  });

  it("is decorative by default and can be described", () => {
    const { container, rerender } = render(<Illustration name="not-found" />);
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
    rerender(<Illustration name="not-found" alt="A missing tile" />);
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("A missing tile");
  });
});

describe("the visual strings", () => {
  const flatten = (value: unknown, prefix = ""): string[] =>
    typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([key, inner]) => flatten(inner, `${prefix}${key}.`))
      : [prefix];

  it("exist in English and French with the same keys", () => {
    const keys = (language: string) =>
      flatten(i18n.getResourceBundle(language, "visual"))
        .map((key) => key.replace(/_(one|other)\.$/, ""))
        .sort();
    expect(keys("fr")).toEqual(keys("en"));
    expect(keys("en").length).toBeGreaterThan(0);
  });
});
