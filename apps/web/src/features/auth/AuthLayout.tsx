import type { ReactNode } from "react";
import { LanguageSwitch, ThemeSwitch } from "../../app/shell/preferences";
import { Gauge, Lamp, Mark, Pictogram, type PictogramName, useDocumentTitle, visualStates } from "../../ui";

const panelPictograms: readonly PictogramName[] = [
  "app",
  "postgres",
  "redis",
  "domain",
  "certificate",
  "deployment",
];

/** The product's own instruments, at rest: lamps, rings and pictograms, on the navy of the top bar. */
function InstrumentPanel() {
  return (
    <div className="grid justify-items-center gap-12">
      <div className="flex items-end gap-8">
        <Gauge value={24} label="" size="md" />
        <Gauge value={41} label="" size="lg" />
        <Gauge value={62} label="" size="md" />
      </div>
      <div className="flex items-center gap-7">
        {visualStates.map((state) => (
          <Lamp key={state} state={state} size="lg" still decorative />
        ))}
      </div>
      <div className="flex items-center gap-7 text-muted">
        {panelPictograms.map((name) => (
          <Pictogram key={name} name={name} size={24} />
        ))}
      </div>
    </div>
  );
}

export function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(460px,540px)_minmax(0,1fr)]">
      <div className="flex min-h-dvh flex-col px-6 py-5 sm:px-10 lg:px-14">
        <div className="flex items-center gap-2">
          <Mark className="size-6" />
          <span className="text-base font-semibold tracking-[-0.005em]">Opsifier</span>
        </div>
        <main className="my-auto w-full max-w-[480px] py-10">
          <h1 className="text-xl font-medium tracking-[-0.01em]">{title}</h1>
          <p className="mt-1.5 text-muted">{description}</p>
          <div className="mt-7">{children}</div>
        </main>
        <div className="flex items-center justify-between">
          <LanguageSwitch />
          <ThemeSwitch />
        </div>
      </div>
      <aside
        aria-hidden="true"
        className="brand-bar relative hidden items-center justify-center border-l lg:flex"
      >
        <InstrumentPanel />
      </aside>
    </div>
  );
}
