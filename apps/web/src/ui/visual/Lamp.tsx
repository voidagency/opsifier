import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { type StateDefinition, stateLanguage, type VisualState } from "./state";
import "./strings";

export const lampSizes = { xs: 10, sm: 12, md: 16, lg: 24, xl: 40 } as const;
export type LampSize = keyof typeof lampSizes;

/** From this size up, a lamp has room for its inner mark. Below it, the outline alone carries the state. */
const DETAIL_FROM = lampSizes.md;

/** Each path is the state's outline followed by its cut-out mark, drawn even-odd so any surface shows through. */
const check = "M4.6 8.7 5.8 7.5 7.3 9 10.5 5.8 11.7 7 7.3 11.4Z";
const exclamation = "M7.1 6h1.8v4.4H7.1ZM7.1 11.2h1.8v1.7H7.1Z";
const cross =
  "M8 6.95 9.85 5.1 10.9 6.15 9.05 8 10.9 9.85 9.85 10.9 8 9.05 6.15 10.9 5.1 9.85 6.95 8 5.1 6.15 6.15 5.1Z";

const disc = "M8 1.5A6.5 6.5 0 1 1 8 14.5 6.5 6.5 0 1 1 8 1.5Z";
const triangle = "M8 1.3 15.5 14.3H.5Z";
const diamond = "M8 .8 15.2 8 8 15.2 .8 8Z";

function Ring({ dashed = false }: { dashed?: boolean }) {
  return (
    <circle
      cx="8"
      cy="8"
      r="5.75"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      pathLength={dashed ? 32 : undefined}
      strokeDasharray={dashed ? "2.4 1.6" : undefined}
      transform={dashed ? "rotate(-11.25 8 8)" : undefined}
    />
  );
}

/** The state's silhouette on a 16-unit grid, drawn in `currentColor`. */
function StateGlyph({
  definition,
  detailed = false,
  still = false,
}: {
  definition: StateDefinition;
  detailed?: boolean;
  /** Draws the glyph without its motion, for places where many lamps sit side by side. */
  still?: boolean;
}) {
  const motion = still ? "none" : definition.motion;

  switch (definition.shape) {
    case "disc":
      return <path d={detailed ? disc + check : disc} fill="currentColor" fillRule="evenodd" />;
    case "triangle":
      return (
        <path
          d={detailed ? triangle + exclamation : triangle}
          fill="currentColor"
          fillRule="evenodd"
          className={cn(motion === "breathe" && "animate-lamp-breathe")}
        />
      );
    case "diamond":
      return (
        <>
          {motion === "alarm" && (
            <path d={diamond} fill="currentColor" className="origin-center animate-lamp-alarm opacity-0" />
          )}
          <path d={detailed ? diamond + cross : diamond} fill="currentColor" fillRule="evenodd" />
        </>
      );
    case "turning-ring":
      return (
        <>
          <Ring />
          <path
            d="M8 4.25a3.75 3.75 0 0 1 0 7.5Z"
            fill="currentColor"
            className={cn("origin-center", motion === "turn" && "animate-lamp-turn")}
          />
        </>
      );
    case "ring":
      return (
        <>
          <Ring />
          {detailed && <rect x="6" y="6" width="4" height="4" fill="currentColor" />}
        </>
      );
    case "broken-ring":
      return (
        <>
          <Ring dashed />
          {detailed && (
            <>
              <path
                d="M6.25 6.5A1.75 1.75 0 1 1 9.1 7.9C8.4 8.4 8 8.8 8 9.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <circle cx="8" cy="11.4" r="0.95" fill="currentColor" />
            </>
          )}
        </>
      );
  }
}

export interface LampProps {
  state: VisualState;
  size?: LampSize;
  /** The lamp's accessible name. Defaults to the state's own label. Say what it is about: "web: failed". */
  label?: string;
  /** Prints the name beside the lamp. Otherwise it is available to assistive technology and on hover. */
  showLabel?: boolean;
  /** Holds the lamp still, for dense lists where many of them would otherwise move at once. */
  still?: boolean;
  /** For a lamp whose parent already carries the name, such as a button. It is hidden from assistive technology. */
  decorative?: boolean;
  className?: string;
}

/** An indicator light. Colour, shape, motion and name all come from the state language. */
export function Lamp({
  state,
  size = "sm",
  label,
  showLabel = false,
  still = false,
  decorative = false,
  className,
}: LampProps) {
  const { t } = useTranslation("visual");
  const definition = stateLanguage[state];
  const name = label ?? t(definition.labelKey);
  const pixels = lampSizes[size];
  const named = !showLabel && !decorative;

  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      data-state={state}
      title={named ? name : undefined}
    >
      <svg
        viewBox="0 0 16 16"
        width={pixels}
        height={pixels}
        className="shrink-0 overflow-visible"
        style={{ color: definition.color }}
        role={named ? "img" : undefined}
        aria-label={named ? name : undefined}
        aria-hidden={named ? undefined : true}
      >
        <StateGlyph definition={definition} detailed={pixels >= DETAIL_FROM} still={still} />
      </svg>
      {showLabel && <span className="text-xs">{name}</span>}
    </span>
  );
}
