import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import {
  builderPictograms,
  conceptPictograms,
  resourcePictograms,
  servicePictograms,
  sourcePictograms,
} from "./pictograms";
import { purposePictograms } from "./purpose-pictograms";
import { templatePictograms } from "./template-pictograms";

const pictograms = {
  ...servicePictograms,
  ...sourcePictograms,
  ...builderPictograms,
  ...resourcePictograms,
  ...conceptPictograms,
  ...purposePictograms,
  ...templatePictograms,
} satisfies Record<string, ReactNode>;

export type PictogramName = keyof typeof pictograms;

export const pictogramNames = Object.keys(pictograms) as PictogramName[];

export function isPictogramName(value: string): value is PictogramName {
  return value in pictograms;
}

/** The pictogram for a source type in the contract. The words differ only where a trademark would show. */
export const sourceTypePictogram: Record<
  "image" | "github" | "git" | "dockerfile" | "upload",
  PictogramName
> = {
  image: "image",
  github: "hosted-repository",
  git: "git",
  dockerfile: "dockerfile",
  upload: "upload",
};

/** The pictogram for a build type in the contract. */
export const buildTypePictogram: Record<
  "dockerfile" | "buildpacks" | "nixpacks" | "railpack",
  PictogramName
> = {
  dockerfile: "dockerfile",
  buildpacks: "buildpacks",
  nixpacks: "nixpacks",
  railpack: "railpack",
};

export interface PictogramProps {
  name: PictogramName;
  /** The drawing's size class. On screen it is a quarter larger, in step with the interface's 5px grid. */
  size?: 16 | 20 | 24;
  /** The accessible name. Leave it out next to text that already says the same thing. */
  label?: string;
  className?: string;
}

export function Pictogram({ name, size = 20, label, className }: PictogramProps) {
  const pixels = size * 1.25;
  return (
    <svg
      viewBox="0 0 24 24"
      width={pixels}
      height={pixels}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="butt"
      strokeLinejoin="miter"
      className={cn("shrink-0", className)}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      data-pictogram={name}
    >
      {pictograms[name]}
    </svg>
  );
}
