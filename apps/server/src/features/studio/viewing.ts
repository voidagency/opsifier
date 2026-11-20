import { type StudioViewing, studioViewing } from "@opsifier/contract";
import { z } from "zod";
import type { DbHandle } from "../../core/db";
import { conflict } from "../../core/errors";
import { findApp } from "./repo";

/**
 * What the project's row keeps of an earlier version shown: what is shown, and the branch to go back
 * to. A version still being shown, or one whose showing ended without a verdict, is `pending`: no
 * message reaches the agent until the folder says where it is.
 */
const storedViewing = studioViewing.extend({ branch: z.string(), pending: z.boolean().optional() });
export type StoredViewing = z.infer<typeof storedViewing>;

/** The earlier version the project's row says is shown, or null for the current one. */
export function readViewing(value: string | null): StoredViewing | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = storedViewing.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What anyone who opens the project is told of it: not the branch, which is the panel's to know. */
export function publicViewing(viewing: StoredViewing | null): StudioViewing | null {
  if (viewing === null) {
    return null;
  }
  const { branch: _branch, pending: _pending, ...shown } = viewing;
  return shown;
}

const viewingConflict = () =>
  conflict(
    "studio_viewing_version",
    "An earlier version is shown in the preview: go back to the current one before writing to the agent.",
  );

/**
 * No message reaches the agent while an earlier version is shown: it would work on that version, on
 * no branch, and what it saved there would be lost once the current one is back.
 */
export function refuseWhileViewing(app: { viewing: string | null }): void {
  if (readViewing(app.viewing) !== null) {
    throw viewingConflict();
  }
}

/**
 * Per project, in this panel: the messages on their way to its agent, and whether the version its
 * folder shows is changing. Each waits for the other, so that no message reaches the agent while its
 * folder moves, and the folder never moves under a message the agent is about to work on.
 */
interface Gate {
  sending: number;
  changing: boolean;
}
const gates = new Map<string, Gate>();

function gateOf(serviceId: string): Gate {
  const known = gates.get(serviceId);
  if (known !== undefined) {
    return known;
  }
  const gate = { sending: 0, changing: false };
  gates.set(serviceId, gate);
  return gate;
}

function forget(serviceId: string, gate: Gate): void {
  if (gate.sending === 0 && !gate.changing && gates.get(serviceId) === gate) {
    gates.delete(serviceId);
  }
}

/**
 * Holds the project's folder for a message, a conversation or a file on its way to the agent, until
 * the returned function is called once it is there. Refused while an earlier version is shown, or is
 * being shown: the row is read once the folder is held, so that a version shown meanwhile counts.
 */
export function holdForMessage(db: DbHandle, serviceId: string): () => void {
  const gate = gateOf(serviceId);
  if (gate.changing || readViewing(findApp(db, serviceId)?.viewing ?? null) !== null) {
    forget(serviceId, gate);
    throw viewingConflict();
  }
  gate.sending += 1;
  let held = true;
  return () => {
    if (held) {
      held = false;
      gate.sending -= 1;
      forget(serviceId, gate);
    }
  };
}

/**
 * Holds the project's folder to change the version it shows, until the returned function is called.
 * Refused while a message is on its way to the agent, or while the version shown is already changing.
 */
export function holdForVersion(serviceId: string): () => void {
  const gate = gateOf(serviceId);
  if (gate.sending > 0) {
    throw conflict(
      "studio_agent_working",
      "A message is on its way to the agent: show an earlier version once it has answered.",
    );
  }
  if (gate.changing) {
    throw conflict("studio_version_busy", "The version shown is changing: try again in a moment.");
  }
  gate.changing = true;
  return () => {
    gate.changing = false;
    forget(serviceId, gate);
  };
}

/** Whether the version the project's folder shows is changing in this panel right now. */
export const versionChanging = (serviceId: string): boolean => gates.get(serviceId)?.changing === true;
