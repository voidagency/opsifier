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
export const studioSettings = z.object({
  enabled: z.boolean(),
  agent: studioAgent.nullable(),
  /**
   * The previews ask for the panel's own sign-in, and let in the server's administrators and the
   * accounts each project is shared with, instead of the password the server's gate shares.
   */
  previewSignIn: z.boolean().default(false),
  /**
   * Each project gets an agent server of its own, in an Opsifier project of its own with its preview:
   * it sees its project's folder and nothing else, reaches its preview and no other service, and has
   * no GitHub token. The service named in `agent` becomes the model each one is copied from: its
   * image, its settings and its models, never its secrets.
   */
  agentPerProject: z.boolean().default(false),
});
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
  /**
   * It ran on the shared agent server, and the project has had its own since: it can be read, and a
   * new conversation goes on with the project's own agent.
   */
  readOnly: z.boolean(),
});
export type StudioConversation = z.infer<typeof studioConversation>;

/**
 * Which agent server works on a project: the one shared by every project, the project's own, or none
 * yet, when each project gets its own and this one is still waiting for it.
 */
export const studioAgentMode = z.enum(["shared", "own", "missing"]);
export type StudioAgentMode = z.infer<typeof studioAgentMode>;

/** A service linked to the Studio: its live preview, and the folder the agent works in. */
export const studioApp = z.object({
  project: z.string(),
  service: z.string(),
  /** The project's folder, as the agent server sees it. */
  workspaceDir: z.string(),
  previewUrl: z.string().nullable(),
  previewStatus: serviceStatus,
  agentMode: studioAgentMode,
  /** The state of the project's own agent server, when it has one. */
  agentStatus: serviceStatus.nullable(),
  lastConversation: studioConversation.nullable(),
});
export type StudioApp = z.infer<typeof studioApp>;

/** GET /api/v1/studio */
export const studioOverview = z.object({
  enabled: z.boolean(),
  agentConfigured: z.boolean(),
  /** Whether a GitHub project can be added: the Studio knows where projects go. */
  canAddProjects: z.boolean(),
  /** Whether each project works with an agent server of its own. */
  agentPerProject: z.boolean(),
  apps: z.array(studioApp),
});
export type StudioOverview = z.infer<typeof studioOverview>;

/** Where a project and its preview are, once it has an agent server of its own. */
export const studioIsolated = z.object({ project: z.string(), service: z.string() });
export type StudioIsolated = z.infer<typeof studioIsolated>;

/** POST /api/v1/studio/isolate: every project still on the shared agent server gets its own. */
export const studioIsolateAll = z.object({
  isolated: z.array(z.object({ from: studioIsolated, to: studioIsolated })),
  failed: z.array(studioIsolated.extend({ message: z.string() })),
});
export type StudioIsolateAll = z.infer<typeof studioIsolateAll>;

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

/** An account a Studio project is shared with. */
export const studioMember = z.object({ userId: z.string(), email: z.string(), addedAt: z.string() });
export type StudioMember = z.infer<typeof studioMember>;

/** GET and PUT .../studio/members: the accounts the project is shared with, by e-mail. */
export const studioMembers = z.object({ members: z.array(studioMember) });
export type StudioMembers = z.infer<typeof studioMembers>;

/** PUT .../studio/members: shares the project with exactly these accounts. */
export const setStudioMembersRequest = z.object({
  userIds: z.array(z.string().min(1).max(100)).max(200),
});
export type SetStudioMembersRequest = z.infer<typeof setStudioMembersRequest>;

/**
 * POST .../studio/preview/start: whether a start was asked for; false when it runs already. A project
 * with an agent server of its own has it started too.
 */
export const studioPreviewStart = z.object({ started: z.boolean(), agentStarted: z.boolean() });

/**
 * What bringing a project's folder up to date with its branch on GitHub found. `updated` brought
 * changes in. Nothing else changes the folder: `blocked`, when files made here and not saved yet are
 * in the way, ignored ones included; `diverged`, when changes saved here are not on GitHub yet, and
 * GitHub has others, which the agent brings together at its next request; `ahead`, when only the
 * folder has new changes; `deferred`, when the project's agent is at work, and gets GitHub's changes
 * before its next one. `unavailable` could not ask GitHub, and says why.
 */
export const studioSyncState = z.enum([
  "current",
  "updated",
  "blocked",
  "diverged",
  "ahead",
  "deferred",
  "unavailable",
]);
export type StudioSyncState = z.infer<typeof studioSyncState>;

export const studioSyncReason = z.enum([
  // The folder is not a copy of a repository.
  "not_a_copy",
  // The folder is on no branch.
  "detached",
  // Git is at work in the folder, the agent's most likely: it is over in a moment.
  "busy",
  // A merge or a rebase stopped halfway, or git left a lock behind: the agent finishes it.
  "interrupted",
  // The branch is not on GitHub.
  "no_branch",
  // GitHub refused the Studio's access, or does not know the repository.
  "no_access",
  // The project's agent server is starting: the update follows in a moment.
  "agent_starting",
  // The project waits for an agent server of its own.
  "no_agent",
  // The agent server does not answer the panel.
  "agent_unavailable",
  "failed",
]);
export type StudioSyncReason = z.infer<typeof studioSyncReason>;

/** POST .../studio/sync?force=true asks GitHub again, rather than reuse an answer of the last seconds. */
export const studioSyncQuery = z.object({ force: z.enum(["true", "false"]).default("false") });

/** POST .../studio/sync. */
export const studioSync = z.object({
  state: studioSyncState,
  branch: z.string().nullable(),
  /** Changes brought in, as commits. */
  pulled: z.number().int().nonnegative(),
  /** Changes on GitHub the folder does not have. */
  behind: z.number().int().nonnegative(),
  /** Changes saved here that GitHub does not have. */
  ahead: z.number().int().nonnegative(),
  /** Files changed here and not saved yet. */
  changed: z.number().int().nonnegative(),
  /** A few of the files in the way of GitHub's changes. */
  blocking: z.array(z.string()),
  /** The changes brought new packages: the preview starts again to install them. */
  previewRestarted: z.boolean(),
  reason: studioSyncReason.nullable(),
});
export type StudioSync = z.infer<typeof studioSync>;

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

/** A GitHub account or organization, as it appears in github.com/<owner>/<repository>. */
export const githubOwner = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, "A GitHub account or organization name");

/** A GitHub token as GitHub writes them: a fine-grained one starts with github_pat_. */
export const githubTokenValue = z
  .string()
  .trim()
  .min(20, "A GitHub token is longer than that")
  .max(255, "Must be at most 255 characters")
  .regex(/^[A-Za-z0-9_]+$/, "A GitHub token holds letters, digits and underscores only");

/**
 * One of the Studio's GitHub keys: a token for every repository of one account or organization, which
 * the panel uses for a project whose repository that owner holds. The token itself is never sent back.
 */
export const studioGithubKey = z.object({
  id: z.string(),
  owner: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /**
   * What the last check found: whether GitHub took the token, whose it is, when it expires, and when it
   * was checked. Null until a check says, and again once the token is replaced.
   */
  valid: z.boolean().nullable(),
  login: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  checkedAt: z.iso.datetime().nullable(),
});
export type StudioGithubKey = z.infer<typeof studioGithubKey>;

/** GET /api/v1/settings/studio/github-keys */
export const studioGithubKeyList = z.object({ keys: z.array(studioGithubKey) });
export type StudioGithubKeyList = z.infer<typeof studioGithubKeyList>;

/** POST /api/v1/settings/studio/github-keys: one key per owner. */
export const addStudioGithubKeyRequest = z.strictObject({ owner: githubOwner, token: githubTokenValue });
export type AddStudioGithubKeyRequest = z.infer<typeof addStudioGithubKeyRequest>;

/** PUT /api/v1/settings/studio/github-keys/{key}: a new token for the same owner. */
export const replaceStudioGithubKeyRequest = z.strictObject({ token: githubTokenValue });
export type ReplaceStudioGithubKeyRequest = z.infer<typeof replaceStudioGithubKeyRequest>;

export const studioGithubKeyPath = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id") });

/** DELETE /api/v1/settings/studio/github-keys/{key} */
export const deletedStudioGithubKey = z.object({ id: z.string() });

/**
 * POST /api/v1/settings/studio/github-keys/{key}/check: what GitHub says of the token. `repositories`
 * counts the private repositories of the owner it reads, when GitHub says.
 */
export const studioGithubKeyCheck = z.object({
  ok: z.boolean(),
  login: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  repositories: z.number().int().min(0).nullable(),
  message: z.string().nullable(),
});
export type StudioGithubKeyCheck = z.infer<typeof studioGithubKeyCheck>;

const recordId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");

/**
 * A link that opens a Studio project's preview to someone without an account, a client most often,
 * who can then leave remarks on it. The link itself is given once, when it is made.
 */
export const studioGuestLink = z.object({
  id: z.string(),
  /** Who it is for, as its maker wrote it: it signs what that person writes. */
  label: z.string(),
  /** Whether it opens the preview with the remarks tool shown. */
  remarks: z.boolean(),
  /** How many remarks were written through it, and are still kept. */
  remarkCount: z.number().int().min(0),
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** Null: it opens the preview until it is taken back. */
  expiresAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  expired: z.boolean(),
});
export type StudioGuestLink = z.infer<typeof studioGuestLink>;

/** GET .../studio/links */
export const studioGuestLinkList = z.object({ links: z.array(studioGuestLink) });
export type StudioGuestLinkList = z.infer<typeof studioGuestLinkList>;

/** POST .../studio/links: the link, with its address, which is never shown again. */
export const createdStudioGuestLink = studioGuestLink.extend({ url: z.string() });
export type CreatedStudioGuestLink = z.infer<typeof createdStudioGuestLink>;

export const createStudioGuestLinkRequest = z.strictObject({
  label: z.string().trim().min(1, "Required").max(80, "Must be at most 80 characters"),
  remarks: z.boolean().default(true),
  /** How many days the link opens the preview for. Null: until it is taken back. */
  days: z.number().int().min(1).max(365).nullable().default(30),
});
export type CreateStudioGuestLinkRequest = z.input<typeof createStudioGuestLinkRequest>;

export const studioGuestLinkPath = servicePath.extend({ link: recordId });

/** DELETE .../studio/links/{link}: `remarks=delete` deletes what was written through it too. */
export const deleteStudioGuestLinkQuery = z.object({ remarks: z.enum(["keep", "delete"]).default("keep") });

/** DELETE .../studio/links/{link} */
export const deletedStudioGuestLink = z.object({ id: z.string() });

/** A remark waits to be dealt with, is with the agent, or is dealt with: its writer sees which. */
export const studioRemarkStatus = z.enum(["new", "in_progress", "done"]);
export type StudioRemarkStatus = z.infer<typeof studioRemarkStatus>;

/** The element a remark points at, as the Studio's inspector describes it. */
export const studioRemarkElement = z.object({
  tag: z.string(),
  text: z.string(),
  classes: z.array(z.string()),
  attributes: z.record(z.string(), z.string()),
  selector: z.string(),
  /** The React components around it, nearest first. */
  components: z.array(z.string()),
});
export type StudioRemarkElement = z.infer<typeof studioRemarkElement>;

/** Where in its element a remark's pin goes, from the top left corner, as fractions of its size. */
export const studioRemarkPoint = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export type StudioRemarkPoint = z.infer<typeof studioRemarkPoint>;

/** The size of the window a remark was written in, which says on what kind of screen. */
export const studioRemarkViewport = z.object({
  width: z.number().int().min(0).max(100_000),
  height: z.number().int().min(0).max(100_000),
});
export type StudioRemarkViewport = z.infer<typeof studioRemarkViewport>;

/** What someone wrote about a page of a Studio project's preview, pinned to one of its elements. */
export const studioRemark = z.object({
  id: z.string(),
  /** Its number in the project, which its pin shows. */
  number: z.number().int(),
  /** The page: its path, query and fragment. */
  path: z.string(),
  element: studioRemarkElement.nullable(),
  point: studioRemarkPoint.nullable(),
  viewport: studioRemarkViewport.nullable(),
  text: z.string(),
  /** Who wrote it: who the link was made for, or an account's e-mail. */
  author: z.string(),
  authorKind: z.enum(["guest", "account"]),
  status: studioRemarkStatus,
  /** The conversation it was handed to, if it was. */
  conversationId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type StudioRemark = z.infer<typeof studioRemark>;

/** GET .../studio/remarks: the project's remarks, the most recent first. */
export const studioRemarkList = z.object({ remarks: z.array(studioRemark) });
export type StudioRemarkList = z.infer<typeof studioRemarkList>;

/** PATCH .../studio/remarks/{remark} */
export const updateStudioRemarkRequest = z.strictObject({
  status: studioRemarkStatus,
  /** The conversation it is handed to. Left out, it stays as it was. */
  conversationId: conversationId.nullable().optional(),
});
export type UpdateStudioRemarkRequest = z.infer<typeof updateStudioRemarkRequest>;

export const studioRemarkPath = servicePath.extend({ remark: recordId });

/** DELETE .../studio/remarks/{remark} */
export const deletedStudioRemark = z.object({ id: z.string() });

/**
 * What the preview's own address answers at /__opsifier/studio/remarks, to whoever a link or the
 * panel's sign-in lets in: who they are, and the project's remarks, without who handled them.
 */
export const studioPreviewRemarks = z.object({
  viewer: z.object({ name: z.string(), kind: z.enum(["guest", "account"]) }),
  remarks: z.array(
    studioRemark
      .pick({
        id: true,
        number: true,
        path: true,
        element: true,
        point: true,
        viewport: true,
        text: true,
        author: true,
        status: true,
        createdAt: true,
      })
      .extend({
        /** Written by this viewer: they may take it back while nobody has dealt with it. */
        mine: z.boolean(),
      }),
  ),
});
export type StudioPreviewRemarks = z.infer<typeof studioPreviewRemarks>;
