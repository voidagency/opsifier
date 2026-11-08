import type { LogLevelFilter, LogSearchResult, LogStreamFilter } from "@opsifier/contract";
import { Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/forms";
import { Button, EmptyState, Field, FormBanner, Input, Select, Skeleton } from "../../ui";
import { searchLogs } from "./api";

const RANGE_SECONDS = { "15m": 900, "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800 } as const;
type Range = keyof typeof RANGE_SECONDS | "all";

const LIMITS = ["100", "500", "2000"] as const;

interface LogSearchProps {
  project: string;
  service: string;
}

/** Looks through what Docker still holds for a service. */
export function LogSearch({ project, service }: LogSearchProps) {
  const { t } = useTranslation(["service-runtime", "common"]);
  const [text, setText] = useState("");
  const [stream, setStream] = useState<LogStreamFilter>("all");
  const [level, setLevel] = useState<LogLevelFilter>("any");
  const [range, setRange] = useState<Range>("1h");
  const [limit, setLimit] = useState<(typeof LIMITS)[number]>("500");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<LogSearchResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async () => {
    setPending(true);
    setFailure(null);
    try {
      setResult(
        await searchLogs(project, service, {
          q: text,
          stream,
          level,
          since: range === "all" ? undefined : RANGE_SECONDS[range],
          limit: Number(limit),
        }),
      );
    } catch (error) {
      setFailure(errorMessage(error, t));
    } finally {
      setPending(false);
    }
  };

  const streamOptions = (["all", "stdout", "stderr"] as const).map((value) => ({
    value,
    label: t(`search.streams.${value}`),
  }));
  const levelOptions = (["any", "error", "warn", "info", "debug"] as const).map((value) => ({
    value,
    label: t(`search.levels.${value}`),
  }));
  const rangeOptions = (["15m", "1h", "6h", "24h", "7d", "all"] as const).map((value) => ({
    value,
    label: t(`search.ranges.${value}`),
  }));
  const limitOptions = LIMITS.map((value) => ({ value, label: value }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <form
        className="grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_repeat(4,minmax(110px,150px))_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <Field label={t("search.text")}>
          <Input
            mono
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            maxLength={256}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("search.placeholder")}
          />
        </Field>
        <Field label={t("search.stream")}>
          <Select
            value={stream}
            onValueChange={(next) => setStream(next as LogStreamFilter)}
            options={streamOptions}
          />
        </Field>
        <Field label={t("search.level")}>
          <Select
            value={level}
            onValueChange={(next) => setLevel(next as LogLevelFilter)}
            options={levelOptions}
          />
        </Field>
        <Field label={t("search.range")}>
          <Select value={range} onValueChange={(next) => setRange(next as Range)} options={rangeOptions} />
        </Field>
        <Field label={t("search.limit")}>
          <Select
            value={limit}
            onValueChange={(next) => setLimit(next as (typeof LIMITS)[number])}
            options={limitOptions}
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          pending={pending}
          icon={<Search aria-hidden="true" className="size-4" />}
        >
          {t("search.submit")}
        </Button>
      </form>

      {failure !== null && <FormBanner>{failure}</FormBanner>}
      <SearchResults result={result} pending={pending} />
    </div>
  );
}

function SearchResults({ result, pending }: { result: LogSearchResult | null; pending: boolean }) {
  const { t } = useTranslation("service-runtime");

  if (pending && result === null) {
    return <Skeleton className="h-40" />;
  }
  if (result === null) {
    return <p className="text-sm text-muted">{t("search.intro")}</p>;
  }
  if (result.lines.length === 0) {
    return <EmptyState title={t("search.empty.title")} description={t("search.empty.description")} />;
  }

  return (
    <>
      <p className="text-xs text-muted">
        {t(result.truncated ? "search.summaryTruncated" : "search.summary", {
          shown: result.lines.length,
          scanned: result.scanned,
        })}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-sm border bg-raised py-2 font-mono text-xs">
        {result.lines.map((line) => (
          <div
            key={line.seq}
            className={cn(
              "relative flex items-start gap-3 px-3 py-px hover:bg-wash",
              line.stream === "stderr" &&
                "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-bad",
            )}
          >
            <span aria-hidden="true" className="shrink-0 select-none text-muted tabular-nums">
              {line.at === null ? "" : new Date(line.at).toLocaleString()}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{line.line}</span>
          </div>
        ))}
      </div>
    </>
  );
}
