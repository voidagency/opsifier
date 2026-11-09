import type { ReactNode } from "react";

/**
 * Pictograms for what a server is for, and for keeping it to itself. They follow the rules of
 * `pictograms.tsx`: one 24-unit grid, one 2-unit stroke, ink plus one amber accent that is never
 * needed to read them.
 */
const amber = { stroke: "var(--highlight)" };

export const purposePictograms = {
  /** Code, still being written. */
  development: (
    <>
      <path d="M8 6 3 12 8 18" />
      <path d="M16 6 21 12 16 18" />
      <path d="M14 4 10 20" {...amber} />
    </>
  ),
  /** A trial, kept apart from the real thing. */
  staging: (
    <>
      <path d="M9 3H15" />
      <path d="M10 3V9L4.5 19A1.4 1.4 0 0 0 5.7 21H18.3A1.4 1.4 0 0 0 19.5 19L14 9V3" />
      <path d="M7 15H17" {...amber} />
    </>
  ),
  /** Out in the open, for the whole world. */
  production: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12H21M12 3C14.5 5.5 15.8 8.6 15.8 12S14.5 18.5 12 21C9.5 18.5 8.2 15.4 8.2 12S9.5 5.5 12 3Z" />
      <path d="M5 6.5H19" {...amber} />
    </>
  ),
  /** Protection, as a thing that is either on or off. */
  shield: (
    <>
      <path d="M12 2.5 20 5.5V12C20 16.4 16.8 19.9 12 21.5 7.2 19.9 4 16.4 4 12V5.5Z" />
      <path d="M8.5 12 11 14.5 15.5 9.5" {...amber} />
    </>
  ),
} satisfies Record<string, ReactNode>;
