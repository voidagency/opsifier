import type { StudioSync } from "@opsifier/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { studioApi } from "./api";

/** While the project's agent server starts, the update is asked for again this often, this many times. */
const AGENT_STARTING_RETRY_MS = 5_000;
const AGENT_STARTING_RETRIES = 8;

export interface ProjectSync {
  /** An update is under way. */
  syncing: boolean;
  /** What the last update found, or null until one has answered. */
  result: StudioSync | null;
  /** The last update could not be asked for. */
  failed: boolean;
  /** Asks GitHub again, rather than take an answer of the last seconds. */
  run: () => void;
}

/**
 * Opening a project brings its folder up to date with GitHub, once per visit, as a hosted builder
 * shows what was pushed meanwhile; and again whenever someone asks. The panel shares one update
 * between people opening the same project at once. When the project's agent server, which runs its
 * git, is still starting, the update is asked for again until it can run.
 */
export function useProjectSync(project: string, service: string): ProjectSync {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<StudioSync | null>(null);
  const [failed, setFailed] = useState(false);
  // An answer for a project left meanwhile is not shown on the next one.
  const shown = useRef(`${project}/${service}`);
  shown.current = `${project}/${service}`;
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Nothing goes on once the page is left: no answer shown, no update asked for again.
  const live = useRef(true);

  const ask = useCallback(
    (force: boolean, retries: number) => {
      const key = `${project}/${service}`;
      if (retry.current !== null) {
        clearTimeout(retry.current);
        retry.current = null;
      }
      setSyncing(true);
      studioApi.sync(project, service, force).then(
        (answer) => {
          if (!live.current || shown.current !== key) {
            return;
          }
          setResult(answer);
          setFailed(false);
          setSyncing(false);
          if (answer.reason === "agent_starting" && retries > 0) {
            retry.current = setTimeout(() => ask(false, retries - 1), AGENT_STARTING_RETRY_MS);
          }
        },
        () => {
          if (live.current && shown.current === key) {
            setFailed(true);
            setSyncing(false);
          }
        },
      );
    },
    [project, service],
  );

  useEffect(() => {
    live.current = true;
    setResult(null);
    setFailed(false);
    ask(false, AGENT_STARTING_RETRIES);
    return () => {
      live.current = false;
      if (retry.current !== null) {
        clearTimeout(retry.current);
        retry.current = null;
      }
    };
  }, [ask]);

  const run = useCallback(() => ask(true, AGENT_STARTING_RETRIES), [ask]);
  return { syncing, result, failed, run };
}
