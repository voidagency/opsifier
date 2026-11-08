import type { ReactNode } from "react";

/**
 * The pictogram set, drawn by hand for Opsifier. One 24-unit grid, one 2-unit stroke, square ends and
 * sharp joins like the bold F of the logo. Two tones: `currentColor` carries the meaning, and one
 * small part in `--highlight` echoes the logo's amber tick. Amber is below 3:1 on white, so a
 * pictogram has to read with the amber part missing.
 *
 * Third-party marks are off limits. Engines, builders and sources are told apart by what they do:
 * a table for a relational store, a fork for a fork, braces for documents, a bolt for an in-memory store.
 */

/** An amber stroke, the same weight as the rest. */
const amber = { stroke: "var(--highlight)" };
/** A solid amber shape. */
const amberFill = { fill: "var(--highlight)", stroke: "none" };
/** A solid ink shape, for parts too small to outline. */
const inkFill = { fill: "currentColor", stroke: "none" };

/** The drum shared by every database: the ring is its lid, with the logo's tick at the top. */
const drum = (
  <>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6V18C4 19.66 7.58 21 12 21S20 19.66 20 18V6" />
    <path d="M9.6 3.25C10.4 3.08 11.2 3 12 3S13.6 3.08 14.4 3.25" {...amber} />
  </>
);

export const servicePictograms = {
  app: (
    <>
      <rect x="3" y="4" width="18" height="16" />
      <path d="M3 10H21" />
      <path d="M6 7H10" {...amber} />
    </>
  ),
  compose: (
    <>
      <rect x="9" y="3" width="6" height="6" />
      <rect x="3" y="15" width="6" height="6" />
      <rect x="15" y="15" width="6" height="6" />
      <path d="M12 9V12M6 15V12H18V15" {...amber} />
    </>
  ),
  box: (
    <>
      <path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z" />
      <path d="M4 7.5 12 12 20 7.5" />
      <path d="M12 12V21" {...amber} />
    </>
  ),
  wordpress: (
    <>
      <g transform="rotate(45 12 12)">
        <path d="M12 21.5 6.5 13.5 9 4.5H15L17.5 13.5Z" />
        <path d="M12 21V14.5" />
        <circle cx="12" cy="12" r="1.9" {...inkFill} />
      </g>
      <path d="M11 21H21" {...amber} />
    </>
  ),
  postgres: (
    <>
      {drum}
      <path d="M12 9V21M4 14.5H20" />
    </>
  ),
  mysql: (
    <>
      {drum}
      <path d="M4 11.5C4 13.16 7.58 14.5 12 14.5S20 13.16 20 11.5" />
    </>
  ),
  mariadb: (
    <>
      {drum}
      <path d="M8 11.5 12 15.5 16 11.5M12 15.5V21" />
    </>
  ),
  mongo: (
    <>
      {drum}
      <path d="M11 11.5H9V14L7 15 9 16V18.5H11M13 11.5H15V14L17 15 15 16V18.5H13" />
    </>
  ),
  redis: (
    <>
      {drum}
      <path d="M13.5 10.5 8 16.5H11.5L10.5 20.5 16 14.5H12.5Z" {...inkFill} />
    </>
  ),
} satisfies Record<string, ReactNode>;

export const sourcePictograms = {
  image: (
    <>
      <path d="M12 2.5 21 7.5 12 12.5 3 7.5Z" />
      <path d="M3 11.5 12 16.5 21 11.5" {...amber} />
      <path d="M3 16 12 21 21 16" />
    </>
  ),
  git: (
    <>
      <path d="M7 4V20M17 12V15H7" />
      <circle cx="7" cy="5" r="2.5" {...inkFill} />
      <circle cx="7" cy="19" r="2.5" {...inkFill} />
      <circle cx="17" cy="9" r="3" {...amberFill} />
    </>
  ),
  "hosted-repository": (
    <>
      <path d="M7 19H17.5A4.5 4.5 0 0 0 18.4 10.1 6.5 6.5 0 0 0 5.7 9.3 5 5 0 0 0 7 19Z" />
      <path d="M12 19V14" />
      <circle cx="12" cy="11.5" r="2.5" {...amberFill} />
    </>
  ),
  dockerfile: (
    <>
      <path d="M6 3H14L19 8V21H5V3Z" />
      <path d="M14 3V8H19" {...amber} />
      <path d="M8.5 12.5 12 14.5 15.5 12.5M8.5 16.5 12 18.5 15.5 16.5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4M7 9 12 4 17 9" />
      <path d="M4 15V20H20V15" {...amber} />
    </>
  ),
} satisfies Record<string, ReactNode>;

export const builderPictograms = {
  buildpacks: (
    <>
      <path d="M5 21V11A7 7 0 0 1 19 11V21Z" />
      <path d="M9.5 4V2.5H14.5V4" />
      <path d="M8.5 21V14.5H15.5V21" />
      <path d="M10.5 17.5H13.5" {...amber} />
    </>
  ),
  nixpacks: (
    <>
      <path d="M8 3H16L21 12 16 21H8L3 12Z" />
      <circle cx="12" cy="12" r="3" />
      <path d="M10 3H14" {...amber} />
    </>
  ),
  railpack: (
    <>
      <rect x="6" y="3" width="12" height="10" />
      <path d="M6 8H18" />
      <path d="M2.5 18H21.5" />
      <path d="M6 16V21M12 16V21M18 16V21" {...amber} />
    </>
  ),
} satisfies Record<string, ReactNode>;

export const resourcePictograms = {
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" />
      <path d="M9 2V6M15 2V6M9 18V22M15 18V22M2 9H6M2 15H6M18 9H22M18 15H22" />
      <rect x="10" y="10" width="4" height="4" {...amberFill} />
    </>
  ),
  memory: (
    <>
      <rect x="3" y="5" width="18" height="11" />
      <path d="M6.5 16V20M12 16V20M17.5 16V20" />
      <path d="M7.5 10.5H16.5" {...amber} />
    </>
  ),
  disk: (
    <>
      <rect x="3" y="4" width="18" height="16" />
      <path d="M3 14H21" />
      <path d="M6 17H10" />
      <path d="M15 17H18" {...amber} />
    </>
  ),
  network: (
    <>
      <path d="M8 20V5M3.5 9.5 8 5 12.5 9.5M16 8V19M11.5 14.5 16 19 20.5 14.5" />
      <path d="M16 4V8" {...amber} />
    </>
  ),
} satisfies Record<string, ReactNode>;

export const conceptPictograms = {
  domain: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12H21" {...amber} />
    </>
  ),
  certificate: (
    <>
      <circle cx="12" cy="9" r="6" />
      <path d="M8 13.5V22L12 19.5 16 22V13.5" />
      <circle cx="12" cy="9" r="2" {...amberFill} />
    </>
  ),
  port: (
    <>
      <path d="M4 20V8H8V4H16V8H20V20Z" />
      <path d="M9 15V20M15 15V20" />
      <path d="M10 4H14" {...amber} />
    </>
  ),
  volume: (
    <>
      <path d="M3 5H9.5L12 8H21V20H3Z" />
      <path d="M3 12H21" {...amber} />
    </>
  ),
  environment: (
    <>
      <path d="M3 6H8" {...amber} />
      <path d="M3 12H8M3 18H8M11 6H21M11 12H21M11 18H17" />
    </>
  ),
  redirect: (
    <>
      <path d="M5 21V17" {...amber} />
      <path d="M5 17V9H18M14 4 19 9 14 14" />
    </>
  ),
  access: (
    <>
      <rect x="5" y="11" width="14" height="10" />
      <path d="M8 11V7.5A4 4 0 0 1 16 7.5V11" />
      <path d="M12 14V18" {...amber} />
    </>
  ),
  maintenance: (
    <>
      <path d="M5 21 10 3H14L19 21" />
      <path d="M3 21H21" />
      <path d="M7.5 13H16.5" {...amber} />
    </>
  ),
  backup: (
    <>
      <rect x="3" y="4" width="18" height="5" />
      <path d="M5 9V20H19V9" />
      <path d="M9.5 13.5H14.5" {...amber} />
    </>
  ),
  restore: (
    <>
      <path d="M5.6 7.6A8 8 0 1 1 4.5 12" />
      <path d="M5.5 3V8H10.5" />
      <path d="M12.5 8V12.5L15.5 14.5" {...amber} />
    </>
  ),
  schedule: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12L15.5 14" />
      <path d="M10 3.2A9 9 0 0 1 14 3.2" {...amber} />
    </>
  ),
  console: (
    <>
      <rect x="3" y="4" width="18" height="16" />
      <path d="M7 8.5 11 12 7 15.5" />
      <path d="M12.5 16H17" {...amber} />
    </>
  ),
  logs: (
    <>
      <rect x="5" y="3" width="14" height="18" />
      <path d="M8 8H16M8 16H13" />
      <path d="M8 12H16" {...amber} />
    </>
  ),
  metrics: (
    <>
      <path d="M4 13H8V20H4ZM10 5H14V20H10ZM16 9H20V20H16Z" {...inkFill} />
      <path d="M2.5 21.5H21.5" {...amber} />
    </>
  ),
  deployment: (
    <>
      <path d="M12 2.5C15.8 5.5 17 9.5 17 13V18H7V13C7 9.5 8.2 5.5 12 2.5Z" />
      <path d="M7 13 3.5 17V21L7 18M17 13 20.5 17V21L17 18" />
      <path d="M12 18.5V22.5" {...amber} />
      <circle cx="12" cy="11" r="1.9" {...inkFill} />
    </>
  ),
  webhook: (
    <>
      <path d="M16 8V14.5A5 5 0 0 1 6 14.5V11" />
      <circle cx="16" cy="5" r="2.5" />
      <path d="M6 11 9 14" {...amber} />
    </>
  ),
  notification: (
    <>
      <path d="M6 17V11A6 6 0 0 1 18 11V17" />
      <path d="M3.5 17H20.5M12 5V2.5" />
      <path d="M9.5 21H14.5" {...amber} />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21V19.5A5.5 5.5 0 0 1 9.5 14H14.5A5.5 5.5 0 0 1 20 19.5V21" />
      <path d="M10.6 4.25A4 4 0 0 1 13.4 4.25" {...amber} />
    </>
  ),
  node: (
    <>
      <rect x="3" y="4" width="18" height="7" />
      <rect x="3" y="13" width="18" height="7" />
      <path d="M6 7.5H10M6 16.5H10" />
      <path d="M15 7.5H18M15 16.5H18" {...amber} />
    </>
  ),
  template: (
    <>
      <rect x="3" y="3" width="18" height="18" />
      <path d="M3 9H21M10 9V21" />
      <path d="M6.5 12.5V17.5" {...amber} />
    </>
  ),
  settings: (
    <>
      <path d="M6 3V21M12 3V21M18 3V21" />
      <rect x="3.5" y="13" width="5" height="4" {...inkFill} />
      <rect x="9.5" y="6" width="5" height="4" {...amberFill} />
      <rect x="15.5" y="15" width="5" height="4" {...inkFill} />
    </>
  ),
  activity: (
    <>
      <path d="M2.5 12H7L10 4.5 14 19.5 16.5 12H19" />
      <path d="M19 12H22" {...amber} />
    </>
  ),
} satisfies Record<string, ReactNode>;
