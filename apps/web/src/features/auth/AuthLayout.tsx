import type { ReactNode } from "react";
import { LanguageSwitch, ThemeSwitch } from "../../app/shell/preferences";
import { ChartSheet, Mark, useDocumentTitle } from "../../ui";

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
        <main className="my-auto w-full max-w-[380px] py-10">
          <h1 className="text-xl font-medium tracking-[-0.01em]">{title}</h1>
          <p className="mt-1.5 text-muted">{description}</p>
          <div className="mt-7">{children}</div>
        </main>
        <div className="flex items-center justify-between">
          <LanguageSwitch />
          <ThemeSwitch />
        </div>
      </div>
      <aside aria-hidden="true" className="relative hidden border-l bg-raised lg:block">
        <div className="absolute inset-0">
          <ChartSheet />
        </div>
      </aside>
    </div>
  );
}
