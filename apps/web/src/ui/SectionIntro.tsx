import { Info } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pictogram, type PictogramName } from "./visual";

export interface SectionIntroProps {
  pictogram: PictogramName;
  title: ReactNode;
  /** The sentence that explains the section. It stays folded away until someone asks for it. */
  description?: ReactNode;
}

/** A section's heading: what it is, in a pictogram and a word, with the explanation on demand. */
export function SectionIntro({ pictogram, title, description }: SectionIntroProps) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <div>
      <div className="flex items-center gap-2">
        <Pictogram name={pictogram} className="text-muted" />
        <h2 className="text-md font-medium">{title}</h2>
        {description && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            aria-label={t("actions.explain")}
            onClick={() => setOpen((value) => !value)}
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink aria-expanded:text-ink"
          >
            <Info aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
      {description && (
        <p id={id} hidden={!open} className="mt-1 text-sm text-muted">
          {description}
        </p>
      )}
    </div>
  );
}
