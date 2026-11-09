import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../lib/forms";
import { Button, buttonClass, FormBanner, Illustration, Mark } from "../ui";

/** Shown while the first session check is running. */
export function BootScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <span className="relative block pb-3">
        <Mark className="size-8 animate-pulse" />
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-px overflow-hidden">
          <span className="block h-full w-1/3 animate-sweep bg-off" />
        </span>
      </span>
    </div>
  );
}

function StateFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[550px] flex-col justify-center gap-4 px-6">{children}</div>
  );
}

export function RootError({ error }: ErrorComponentProps) {
  const { t } = useTranslation(["shell", "common"]);
  const router = useRouter();
  return (
    <StateFrame>
      <div>
        <Illustration name="not-found" size={200} />
        <h1 className="mt-4 text-lg font-medium">{t("error.title")}</h1>
        <p className="mt-1 text-muted">{t("error.description")}</p>
      </div>
      <FormBanner>{errorMessage(error, t)}</FormBanner>
      <div>
        <Button variant="primary" onClick={() => router.invalidate()}>
          {t("common:actions.retry")}
        </Button>
      </div>
    </StateFrame>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation("shell");
  return (
    <StateFrame>
      <div>
        <Illustration name="not-found" size={200} />
        <p className="mt-4 font-mono text-sm text-muted">404</p>
        <h1 className="mt-1 text-lg font-medium">{t("notFound.title")}</h1>
        <p className="mt-1 text-muted">{t("notFound.description")}</p>
      </div>
      <div>
        <Link to="/" className={buttonClass("secondary", "md")}>
          {t("notFound.back")}
        </Link>
      </div>
    </StateFrame>
  );
}
