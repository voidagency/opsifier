import type { TemplateDocument } from "@opsifier/contract";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { Button, Dialog, Field, FormBanner, SectionIntro, Textarea } from "../../ui";
import { templatesApi } from "./api";
import { TemplateDialog } from "./TemplateDialog";

const EXAMPLE = `{
  "id": "my-app",
  "version": "1.0.0",
  "name": "My app",
  "summary": { "en": "One line about it", "fr": "Une ligne à son sujet" },
  "description": { "en": "A few words more.", "fr": "Quelques mots de plus." },
  "category": "development",
  "secrets": [{ "key": "token" }],
  "services": [
    {
      "kind": "database",
      "key": "db",
      "name": "my-app-db",
      "engine": "postgres",
      "image": "postgres:17.11-alpine",
      "databaseName": "app",
      "user": "app"
    },
    {
      "kind": "app",
      "key": "app",
      "name": "my-app",
      "source": { "type": "image", "image": "traefik/whoami:v1.10" },
      "env": {
        "DATABASE_URL": "{{services.db.url}}",
        "API_TOKEN": "{{secrets.token}}"
      },
      "domain": { "port": 80 },
      "startup": { "path": "/", "expect": [200] },
      "dependsOn": ["db"]
    }
  ]
}`;

function SchemaDialog({
  open,
  onOpenChange,
  onDocument,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDocument: (document: TemplateDocument, schema: string) => void;
}) {
  const { t } = useTranslation(["templates", "common"]);
  const [schema, setSchema] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBanner(null);
    try {
      // Checked here first: there is no need to ask the server about text that is not JSON.
      JSON.parse(schema);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : t("custom.invalidJson"));
      return;
    }
    setError(null);
    setPending(true);
    try {
      onDocument(await templatesApi.preview(schema), schema);
      onOpenChange(false);
    } catch (cause) {
      const fields = (cause as { fields?: Record<string, string> }).fields;
      if (fields?.schema !== undefined) {
        setError(fields.schema);
      } else {
        setBanner(errorMessage(cause, t));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("custom.dialogTitle")}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={pending}>
            {t("custom.next")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {banner !== null && <FormBanner>{banner}</FormBanner>}
        <Field label={t("custom.schema")} hint={t("custom.schemaHint")} error={error ?? undefined}>
          <Textarea
            value={schema}
            onChange={(event) => {
              setSchema(event.currentTarget.value);
              setError(null);
            }}
            mono
            rows={18}
            spellCheck={false}
            className="text-xs"
          />
        </Field>
        <Button size="sm" className="justify-self-start" onClick={() => setSchema(EXAMPLE)}>
          {t("custom.useExample")}
        </Button>
      </div>
    </Dialog>
  );
}

/** Installs a document written by hand: it goes through the same form as the catalogue. */
export function CustomTab({ project }: { project: string }) {
  const { t } = useTranslation("templates");
  const [opening, setOpening] = useState(false);
  const [chosen, setChosen] = useState<{ document: TemplateDocument; schema: string } | null>(null);

  return (
    <div className="grid max-w-[900px] gap-4">
      <SectionIntro pictogram="template" title={t("custom.title")} description={t("custom.description")} />
      <p className="text-sm text-muted">{t("custom.body")}</p>
      <div>
        <Button variant="primary" onClick={() => setOpening(true)}>
          {t("custom.open")}
        </Button>
      </div>
      <SchemaDialog
        open={opening}
        onOpenChange={setOpening}
        onDocument={(document, schema) => setChosen({ document, schema })}
      />
      {chosen !== null && (
        <TemplateDialog
          key={chosen.document.id}
          template={chosen.document}
          project={project}
          source={{ type: "schema", schema: chosen.schema }}
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
