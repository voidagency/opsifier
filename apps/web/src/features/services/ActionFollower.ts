import { type ActionEntry, actionsTopic } from "@opsifier/contract";
import { useCallback, useRef } from "react";
import { useTopic } from "../../lib/realtime";

export interface FollowMessages {
  success: () => void;
  failure: (action: ActionEntry) => void;
}

/** Reports the end of Actions this browser started, once, even if several events for one arrive. */
export function useActionFollower(): (id: string, messages: FollowMessages) => void {
  const followed = useRef(new Map<string, FollowMessages>());

  useTopic<ActionEntry>(actionsTopic, (action) => {
    const messages = followed.current.get(action.id);
    if (messages === undefined || action.status === "queued" || action.status === "running") {
      return;
    }
    followed.current.delete(action.id);
    if (action.status === "succeeded") {
      messages.success();
    } else if (action.status === "failed") {
      messages.failure(action);
    }
  });

  return useCallback((id, messages) => {
    followed.current.set(id, messages);
  }, []);
}
