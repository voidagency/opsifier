import type { StudioAgent, StudioEventPage } from "@opsifier/contract";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import type { AppDeps } from "../../core/context";
import type { Db, DbHandle } from "../../core/db";
import { studioConversationEvents } from "../../core/db/schema";
import { callAgent, expectJson } from "./agent";
import { toStudioEvents } from "./events";
import * as repo from "./repo";

/**
 * The copy the panel keeps of each conversation with a project's own agent server, so that it still
 * shows while that server sleeps: a read never wakes it. The copy holds the agent server's events as
 * they came, turned into what the Studio shows when it is read, so that a later version shows them
 * its own way. It grows as the conversation is read, and before the server is put to sleep, only
 * from where it ends, so that it never has a gap: a page is kept when it holds the copy's last event,
 * or starts the conversation for an empty copy, and is left out otherwise.
 */

/** Past this, the copy lets its oldest events go: the agent server still has everything. */
export const MAX_COPIED_EVENTS = 10_000;
/** Events in a page read from the copy, as from the agent server. */
export const COPY_PAGE_SIZE = 100;
/** Pages read at most for one conversation when its copy is brought up to date before a sleep. */
const CATCH_UP_PAGES = 20;
/** Conversations brought up to date before a sleep: the most recent ones. */
const CATCH_UP_CONVERSATIONS = 5;

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The last event the copy holds. */
function lastCopied(db: DbHandle, conversationId: string): { position: number; eventId: string } | undefined {
  return db
    .select({ position: studioConversationEvents.position, eventId: studioConversationEvents.eventId })
    .from(studioConversationEvents)
    .where(eq(studioConversationEvents.conversationId, conversationId))
    .orderBy(desc(studioConversationEvents.position))
    .limit(1)
    .get();
}

/**
 * Keeps what a page of the agent server's events adds to the copy. `after` is the event the page was
 * asked to follow; the agent server starts the page with it.
 */
export function keepCopy(
  db: Db,
  conversationId: string,
  after: string | undefined,
  raws: readonly Raw[],
  max = MAX_COPIED_EVENTS,
): void {
  db.transaction((tx) => {
    const last = lastCopied(tx, conversationId);
    const ids = raws.map((raw) => (typeof raw.id === "string" && raw.id !== "" ? raw.id : null));
    let start: number;
    if (last === undefined) {
      // An empty copy starts with the conversation's first event, nowhere else.
      if (after !== undefined) {
        return;
      }
      start = 0;
    } else {
      const at = ids.indexOf(last.eventId);
      if (at >= 0) {
        start = at + 1;
      } else if (after === last.eventId) {
        start = 0;
      } else {
        return;
      }
    }
    let position = last?.position ?? 0;
    for (const [index, raw] of raws.entries()) {
      const eventId = ids[index];
      if (index < start) {
        continue;
      }
      // Without an identifier, nothing could follow it: the copy ends here until a later page.
      if (eventId === null || eventId === undefined) {
        break;
      }
      position += 1;
      tx.insert(studioConversationEvents)
        .values({ conversationId, position, eventId, data: JSON.stringify(raw) })
        .onConflictDoNothing()
        .run();
    }
    // The newest are kept: they are what a sleeping conversation is opened for.
    tx.delete(studioConversationEvents)
      .where(
        and(
          eq(studioConversationEvents.conversationId, conversationId),
          lte(studioConversationEvents.position, position - max),
        ),
      )
      .run();
  });
}

/**
 * A page of what the copy holds after `after`, oldest first, from its start without one. An `after`
 * the copy does not hold gives nothing, and keeps the caller where it was.
 */
export function readCopy(
  db: DbHandle,
  conversationId: string,
  after: string | undefined,
  title: string | null,
  workspaceDir: string | undefined,
  pageSize = COPY_PAGE_SIZE,
): StudioEventPage {
  let from = 0;
  if (after !== undefined) {
    const known = db
      .select({ position: studioConversationEvents.position })
      .from(studioConversationEvents)
      .where(
        and(
          eq(studioConversationEvents.conversationId, conversationId),
          eq(studioConversationEvents.eventId, after),
        ),
      )
      .get();
    if (known === undefined) {
      return { items: [], cursor: after, status: "idle", title, model: null, more: false, asleep: true };
    }
    from = known.position;
  }
  const rows = db
    .select({ eventId: studioConversationEvents.eventId, data: studioConversationEvents.data })
    .from(studioConversationEvents)
    .where(
      and(
        eq(studioConversationEvents.conversationId, conversationId),
        gt(studioConversationEvents.position, from),
      ),
    )
    .orderBy(asc(studioConversationEvents.position))
    .limit(pageSize + 1)
    .all();
  const page = rows.slice(0, pageSize);
  return {
    items: toStudioEvents(
      page.map((row) => safeJson(row.data)),
      workspaceDir,
    ),
    cursor: page.at(-1)?.eventId ?? after ?? null,
    status: "idle",
    title,
    model: null,
    more: rows.length > pageSize,
    asleep: true,
  };
}

/**
 * Brings the copies of a project's recent conversations up to what its agent server holds, before
 * the server is put to sleep: what happened after anyone last looked still shows while it sleeps.
 * A conversation that cannot be read keeps the copy it has.
 */
export async function catchUpCopies(deps: AppDeps, agent: StudioAgent, appId: string): Promise<void> {
  const recent = repo
    .listConversations(deps.db, appId)
    .filter((conversation) => !conversation.sharedAgent)
    .slice(0, CATCH_UP_CONVERSATIONS);
  for (const conversation of recent) {
    try {
      for (let read = 0; read < CATCH_UP_PAGES; read += 1) {
        const after = lastCopied(deps.db, conversation.id)?.eventId;
        const query = new URLSearchParams({ limit: String(COPY_PAGE_SIZE), sort_order: "TIMESTAMP" });
        if (after !== undefined) {
          query.set("page_id", after);
        }
        const { keyFound, replies } = await callAgent(deps, agent, [
          {
            method: "GET",
            path: `/api/conversations/${conversation.id}/events/search?${query}`,
            shape: "events",
          },
        ]);
        const page = expectJson(replies[0], keyFound);
        const raws = isRecord(page) && Array.isArray(page.items) ? page.items.filter(isRecord) : [];
        keepCopy(deps.db, conversation.id, after, raws);
        const more = isRecord(page) && typeof page.next_page_id === "string" && page.next_page_id !== "";
        // Nothing more, or nothing the copy could take: it is as far as it goes.
        if (!more || lastCopied(deps.db, conversation.id)?.eventId === after) {
          break;
        }
      }
    } catch (error) {
      deps.logger.warn(
        { err: error, conversation: conversation.id },
        "Could not bring a Studio conversation's copy up to date before its agent server sleeps",
      );
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
