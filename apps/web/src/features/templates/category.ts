import type { LocalizedText, TemplateCategory } from "@opsifier/contract";
import type { PictogramName } from "../../ui";

/** Each category is drawn, so a template needs no logo of its own. */
export const categoryPictograms: Record<TemplateCategory, PictogramName> = {
  monitoring: "metrics",
  development: "git",
  data: "postgres",
  documents: "document",
  productivity: "checklist",
  communication: "notification",
  media: "media",
  automation: "webhook",
  security: "access",
  infrastructure: "node",
};

/** A piece of template text in the interface's language. */
export function localized(text: LocalizedText, language: string): string {
  return language.startsWith("fr") ? text.fr : text.en;
}
