/** WCAG 2.2 contrast between two opaque `#rrggbb` colours, used by the tests and the review gallery. */

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (match === null) {
    throw new Error(`Not a #rrggbb colour: ${color}`);
  }
  const [red, green, blue] = [match[1], match[2], match[3]].map((part) =>
    channel(Number.parseInt(part ?? "", 16)),
  );
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Non-text indicators need 3:1, body text 4.5:1. */
export const MIN_INDICATOR_CONTRAST = 3;
export const MIN_TEXT_CONTRAST = 4.5;
