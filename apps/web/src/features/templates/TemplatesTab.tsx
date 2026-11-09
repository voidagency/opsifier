import { type TemplateCategory, type TemplateDocument, templateCategories } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { Badge, EmptyState, ErrorState, Field, Input, Pictogram, Select, Skeleton } from "../../ui";
import { templatesQuery } from "./api";
import { categoryPictograms, localized } from "./category";
import { TemplateDialog } from "./TemplateDialog";

const ALL = "__all__";

function TemplateRow({
  template,
  language,
  onOpen,
}: {
  template: TemplateDocument;
  language: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation("templates");
  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 px-1 py-3 text-left hover:bg-wash"
      >
        <span title={t(`categories.${template.category}`)} className="text-muted">
          <Pictogram name={categoryPictograms[template.category]} size={24} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">{template.name}</span>
          <span className="block truncate text-xs text-muted">{localized(template.summary, language)}</span>
        </span>
        <span className="flex items-center gap-2">
          {template.verified && <Badge tone="ok">{t("catalogue.verified")}</Badge>}
          <span className="hidden font-mono text-xs text-muted sm:inline">v{template.version}</span>
        </span>
      </button>
    </li>
  );
}

function matches(template: TemplateDocument, query: string, language: string): boolean {
  if (query === "") {
    return true;
  }
  const haystack = [template.name, localized(template.summary, language), ...template.tags]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

/** The catalogue: filter it, open one, and the form takes it from there. */
export function TemplatesTab({ project }: { project: string }) {
  const { t, i18n } = useTranslation(["templates", "common"]);
  const language = i18n.language;
  const { data, isPending, isError, error, refetch } = useQuery(templatesQuery);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState(ALL);
  const [category, setCategory] = useState<TemplateCategory | null>(null);
  const [chosen, setChosen] = useState<TemplateDocument | null>(null);

  const templates = data?.templates ?? [];
  const tags = useMemo(
    () => [...new Set(templates.flatMap((template) => template.tags))].sort(),
    [templates],
  );
  const needle = query.trim().toLowerCase();
  const filtered = templates.filter(
    (template) =>
      (category === null || template.category === category) &&
      (tag === ALL || template.tags.includes(tag)) &&
      matches(template, needle, language),
  );

  if (isPending) {
    return (
      <div className="grid max-w-[1100px] gap-3">
        <Skeleton className="h-9" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    );
  }
  if (isError) {
    return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }

  return (
    <div className="grid max-w-[1100px] gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <Field
          label={t("catalogue.search")}
          hint={t("catalogue.searchHint")}
          className="min-w-[250px] flex-1"
        >
          <div className="relative">
            <Search aria-hidden="true" className="absolute top-2.5 left-2.5 size-4 text-muted" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t("catalogue.search")}
              className="pl-8"
            />
          </div>
        </Field>
        <Field label={t("catalogue.tag")} hint={t("catalogue.tagHint")} className="w-[250px]">
          <Select
            value={tag}
            onValueChange={setTag}
            options={[
              { value: ALL, label: t("catalogue.anyTag") },
              ...tags.map((value) => ({ value, label: value })),
            ]}
          />
        </Field>
      </div>

      <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0">
        <legend className="sr-only">{t("catalogue.categories")}</legend>
        {templateCategories.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={category === value}
            onClick={() => setCategory(category === value ? null : value)}
            className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-off px-2 text-xs text-muted hover:text-ink aria-pressed:bg-wash aria-pressed:font-medium aria-pressed:text-ink"
          >
            <Pictogram name={categoryPictograms[value]} size={16} />
            {t(`categories.${value}`)}
          </button>
        ))}
      </fieldset>

      {filtered.length === 0 ? (
        <EmptyState
          illustration="no-services"
          title={t("catalogue.emptyTitle")}
          description={t("catalogue.emptyBody")}
        />
      ) : (
        <ul className="border-y">
          {filtered.map((template) => (
            <TemplateRow
              key={template.id}
              template={template}
              language={language}
              onOpen={() => setChosen(template)}
            />
          ))}
        </ul>
      )}

      {chosen !== null && (
        <TemplateDialog
          key={chosen.id}
          template={chosen}
          project={project}
          source={{ type: "catalogue", id: chosen.id }}
          open
          onOpenChange={(open) => {
            if (!open) {
              setChosen(null);
            }
          }}
        />
      )}
    </div>
  );
}
