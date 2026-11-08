import { z } from "zod";

const MAX_TEXT = 200;
const MAX_CSS = 16 * 1024;
const MAX_LOGO = 128 * 1024;
const LOGO = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

/** A `<` that would end the style element the CSS is written into. */
const ENDS_STYLE = /<\/style/i;

const shortText = z.string().trim().max(MAX_TEXT, "This is too long");

/** PUT /api/v1/projects/{project}/services/{service}/maintenance */
export const maintenanceSettings = z.object({
  enabled: z.boolean().default(false),
  title: shortText.default(""),
  subtitle: shortText.default(""),
  /** An inline image, so the page needs nothing from outside. */
  customLogo: z
    .string()
    .max(MAX_LOGO, "The image is too large")
    .regex(LOGO, "Choose a PNG, JPEG, GIF, WebP or SVG image")
    .nullable()
    .default(null),
  customCss: z
    .string()
    .max(MAX_CSS, "This is too long")
    .refine((value) => !ENDS_STYLE.test(value), "CSS can't contain </style")
    .default(""),
  hideLogo: z.boolean().default(false),
  hideLinks: z.boolean().default(false),
});
export type MaintenanceSettings = z.infer<typeof maintenanceSettings>;
export type MaintenanceSettingsInput = z.input<typeof maintenanceSettings>;

export { MAX_LOGO as MAX_MAINTENANCE_LOGO_BYTES };
