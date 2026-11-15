import { z } from "zod";
import { projectName, resourceName } from "./common";
import { servicePath, serviceStatus } from "./services";

const absolutePath = z
  .string()
  .max(300)
  .regex(/^\/[^\0\n]*$/, "An absolute path");

/**
 * The service that runs an OpenHands agent server for the Studio, and where the server listens inside
 * that service's container. The panel talks to it from inside the container, so the agent server needs
 * no domain, and its key stays there: it is read from `SESSION_API_KEY`, `OH_SESSION_API_KEYS_0` or
 * `keyFile`, in that order.
 */
export const studioAgent = z.object({
  project: projectName,
  service: resourceName,
  url: z
    .string()
    .max(100)
    .regex(/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/, "An http address on 127.0.0.1 or localhost"),
  keyFile: absolutePath.nullable(),
  /**
   * Where the projects live in the agent server's container, mounted from a folder of the server. A
   * project added to the Studio is copied there, and its preview mounts the same folder. Null leaves
   * adding projects off: a project is then linked by hand.
   */
  projectsDir: absolutePath.nullable().default(null),
});
export type StudioAgent = z.infer<typeof studioAgent>;

/** GET and PUT /api/v1/settings/studio */
export const studioSettings = z.object({ enabled: z.boolean(), agent: studioAgent.nullable() });
export type StudioSettings = z.infer<typeof studioSettings>;

/** POST /api/v1/settings/studio/check: whether the panel reaches the agent server, and with its key. */
export const studioCheck = z.object({
  reachable: z.boolean(),
  version: z.string().nullable(),
  message: z.string().nullable(),
});
export type StudioCheck = z.infer<typeof studioCheck>;

/** What the agent of a conversation is doing. `waiting` is waiting for a confirmation. */
export const studioConversationStatus = z.enum([
  "idle",
  "running",
  "waiting",
  "paused",
  "finished",
  "error",
  "stuck",
  "unknown",
]);
export type StudioConversationStatus = z.infer<typeof studioConversationStatus>;

export const studioConversation = z.object({
  id: z.string(),
  title: z.string().nullable(),
  /** Who started it. */
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StudioConversation = z.infer<typeof studioConversation>;

/** A service linked to the Studio: its live preview, and the folder the agent works in. */
export const studioApp = z.object({
  project: z.string(),
  service: z.string(),
  /** The project's folder, as the agent server sees it. */
  workspaceDir: z.string(),
  previewUrl: z.string().nullable(),
  previewStatus: serviceStatus,
  lastConversation: studioConversation.nullable(),
});
export type StudioApp = z.infer<typeof studioApp>;

/** GET /api/v1/studio */
export const studioOverview = z.object({
  enabled: z.boolean(),
  agentConfigured: z.boolean(),
  /** Whether a GitHub project can be added: the Studio knows where projects go. */
  canAddProjects: z.boolean(),
  apps: z.array(studioApp),
});
export type StudioOverview = z.infer<typeof studioOverview>;

/** GET and PUT /api/v1/projects/{project}/services/{service}/studio */
export const studioAppDetail = studioApp.extend({ conversations: z.array(studioConversation) });
export type StudioAppDetail = z.infer<typeof studioAppDetail>;

export const linkStudioAppRequest = z.object({ workspaceDir: absolutePath });
export type LinkStudioAppRequest = z.infer<typeof linkStudioAppRequest>;

/**
 * POST /api/v1/studio/projects: copies a GitHub repository into the projects folder, from inside the
 * agent server's container and with its GitHub token, makes the project's preview, and links it.
 */
export const addStudioProjectRequest = z.object({
  /** https://github.com/owner/name, git@github.com:owner/name.git, or owner/name. */
  repository: z.string().trim().min(1, "Required").max(300),
  /** The branch to work on. The repository's default branch when left out. */
  branch: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9._/-]+$/, "A branch name")
    .refine((value) => !value.startsWith("-") && !value.includes(".."), "A branch name")
    .optional(),
});
export type AddStudioProjectRequest = z.input<typeof addStudioProjectRequest>;

/** DELETE .../studio: the service is no longer in the Studio. Its preview and folder stay. */
export const unlinkedStudioApp = z.object({ project: z.string(), service: z.string() });

/** An image pasted into a message, sent inline. The panel's request size limit applies to the whole message. */
export const studioImage = z
  .string()
  .max(1_000_000)
  .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/, "A PNG, JPEG, WebP or GIF image");

/** POST .../studio/conversations, which starts one, and .../conversations/{conversation}/messages */
export const studioMessageRequest = z
  .object({
    text: z.string().max(20_000).default(""),
    images: z.array(studioImage).max(4).default([]),
    /** The agent server's model profile for a conversation being started. Its active one when left out. */
    model: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
  })
  .refine((message) => message.text.trim() !== "" || message.images.length > 0, {
    message: "Write a message or add an image",
    path: ["text"],
  });
export type StudioMessageRequest = z.input<typeof studioMessageRequest>;

const eventFields = { id: z.string(), timestamp: z.string() };

/**
 * What a conversation shows: the messages, each action of the agent in a line, and its errors. The
 * agent's own reasoning, the results of its tools and its system prompt are left out.
 */
export const studioEvent = z.discriminatedUnion("kind", [
  z.object({
    ...eventFields,
    kind: z.literal("message"),
    role: z.enum(["user", "agent"]),
    text: z.string(),
    images: z.array(z.string()),
    /** What the agent suggests asking next, taken out of its message's text. */
    suggestions: z.array(z.string()),
  }),
  z.object({
    ...eventFields,
    kind: z.literal("action"),
    tool: z.string(),
    /** What kind of thing the action does, for an interface to say in its own words. */
    verb: z.enum(["command", "read", "edit", "create", "browse", "look", "search", "plan", "other"]),
    /** The agent's own words for it when it gave some, otherwise a plain description. */
    summary: z.string(),
    /** Whether `summary` is the agent's own words. */
    described: z.boolean(),
    /** The command, file or address it acted on. A file inside the project's folder is given from there. */
    detail: z.string().nullable(),
    /** What the agent wrote as it took the step, for the person following along. */
    thought: z.string().nullable(),
    /** The agent's plan, when the step updates it. */
    tasks: z
      .array(z.object({ title: z.string(), status: z.enum(["todo", "in_progress", "done"]) }))
      .nullable(),
  }),
  z.object({ ...eventFields, kind: z.literal("error"), text: z.string() }),
]);
export type StudioEvent = z.infer<typeof studioEvent>;

/**
 * A model the agent works with, and whether what it is sent stays on private addresses, such as a model
 * served on one's own machines, or goes to an outside provider.
 */
export const studioModel = z.object({
  /** The agent server's profile for it, when known. */
  profile: z.string().nullable(),
  name: z.string(),
  host: z.string().nullable(),
  private: z.boolean(),
});
export type StudioModel = z.infer<typeof studioModel>;

/** GET /api/v1/studio/models: the agent server's model profiles, and the one a conversation starts with. */
export const studioModels = z.object({
  active: z.string().nullable(),
  models: z.array(studioModel),
});
export type StudioModels = z.infer<typeof studioModels>;

/** GET .../conversations/{conversation}/events: the events after `after`, oldest first. */
export const studioEventPage = z.object({
  items: z.array(studioEvent),
  /** Pass it back as `after` to get what comes next. Null when the conversation has no event yet. */
  cursor: z.string().nullable(),
  status: studioConversationStatus,
  title: z.string().nullable(),
  /** The model the conversation works with. */
  model: studioModel.nullable(),
  /** Whether more events are already waiting: ask again at once, as after reopening a long conversation. */
  more: z.boolean(),
});
export type StudioEventPage = z.infer<typeof studioEventPage>;

const conversationId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/);

export const studioConversationPath = servicePath.extend({ conversation: conversationId });
export const studioEventsQuery = z.object({ after: conversationId.optional() });
