import { cn } from "../../lib/cn";

export const illustrationNames = [
  "no-projects",
  "no-services",
  "no-deployments",
  "no-domains",
  "no-backups",
  "no-activity",
  "not-found",
  "service-stopped",
] as const;
export type IllustrationName = (typeof illustrationNames)[number];

const ART_SIZE = 720;

export interface IllustrationProps {
  name: IllustrationName;
  /** Only when the picture says something the text next to it does not. Empty states leave it empty. */
  alt?: string;
  /** Displayed width and height in pixels. The space is reserved before the image loads. */
  size?: number;
  className?: string;
}

/**
 * Art for empty and error states, in `public/illustrations`. Theme selection is pure CSS on
 * `data-theme`, so it is right before first paint, and lazy loading never fetches the hidden variant.
 */
export function Illustration({ name, alt = "", size = 180, className }: IllustrationProps) {
  return (
    <span
      className={cn("inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      data-illustration={name}
    >
      {(["light", "dark"] as const).map((variant) => (
        <img
          key={variant}
          src={`/illustrations/${name}-${variant}.webp`}
          alt={alt}
          width={ART_SIZE}
          height={ART_SIZE}
          loading="lazy"
          decoding="async"
          draggable={false}
          className={`illustration-${variant} size-full`}
        />
      ))}
    </span>
  );
}
