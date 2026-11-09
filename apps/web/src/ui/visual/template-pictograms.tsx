import type { ReactNode } from "react";

/**
 * Pictograms for the template catalogue's categories, drawn by hand to the same rules as the rest of
 * the set: one 24-unit grid, one 2-unit stroke, ink plus one amber accent that it reads without.
 */
const amber = { stroke: "var(--highlight)" };

export const templatePictograms = {
  document: (
    <>
      <path d="M6 3H14L18 7V21H6V3Z" />
      <path d="M14 3V7H18" />
      <path d="M9 12H15" {...amber} />
      <path d="M9 16H15" />
    </>
  ),
  checklist: (
    <>
      <path d="M4 6.5 5.7 8.2 8.5 5" {...amber} />
      <path d="M11 7H20" />
      <path d="M4 12.5 5.7 14.2 8.5 11" />
      <path d="M11 13H20" />
      <path d="M4 18.5 5.7 20.2 8.5 17" />
      <path d="M11 19H20" />
    </>
  ),
  media: (
    <>
      <rect x="3" y="5" width="18" height="14" />
      <path d="M10 9V15L15 12Z" {...amber} />
    </>
  ),
} satisfies Record<string, ReactNode>;
