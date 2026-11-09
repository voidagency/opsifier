import type { BoxIdeEntry, BoxIdeFile, BoxIdeSession } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  ChevronRight,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Pencil,
  Save,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isApiError } from "../../../lib/api";
import { formatRelativeTime } from "../../../lib/format";
import { errorMessage } from "../../../lib/forms";
import {
  Button,
  CodeEditor,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormBanner,
  Input,
  Lamp,
  Mark,
  Skeleton,
  useDocumentTitle,
} from "../../../ui";
import { createIdeClient, type IdeClient } from "./api";

const STORAGE_PREFIX = "opsifier.ide.";

function readStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) {
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, value);
    }
  } catch {
    // Storage can be blocked: the token then lasts as long as this page.
  }
}

/** A token handed over in the link's fragment, which never reaches a server or a log. */
function takeTokenFromUrl(): string | null {
  const match = /^#token=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (match === null) {
    return null;
  }
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return match[1] ?? null;
}

type Refusal = "none" | "needed" | "expired" | "invalid";

function refusalFrom(error: unknown): Refusal | null {
  if (!isApiError(error) || error.status !== 401) {
    return null;
  }
  return error.code === "ide_token_expired" ? "expired" : "invalid";
}

interface OpenFile {
  path: string;
  /** What the disk held when it was opened, or last saved. */
  saved: string;
  draft: string;
  version: string;
}

type Pending =
  | { kind: "file" | "folder"; parent: string }
  | { kind: "rename"; path: string }
  | { kind: "delete"; path: string; isFolder: boolean };

const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const join = (parent: string, name: string): string => (parent === "" ? name : `${parent}/${name}`);

function SignInForm({ refusal, onSubmit }: { refusal: Refusal; onSubmit: (token: string) => void }) {
  const { t } = useTranslation("service-box-ide");
  const [value, setValue] = useState("");
  const message =
    refusal === "expired"
      ? t("page.signIn.expired")
      : refusal === "invalid"
        ? t("page.signIn.invalid")
        : null;
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value.trim());
      }}
    >
      {message !== null && <FormBanner>{message}</FormBanner>}
      <p className="text-muted">{t("page.signIn.body")}</p>
      <Field label={t("page.signIn.token")} hint={t("page.signIn.tokenHint")}>
        <Input
          mono
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </Field>
      <Button type="submit" variant="primary" disabled={value.trim() === ""}>
        {t("page.signIn.submit")}
      </Button>
    </form>
  );
}

function SignInPage({
  project,
  service,
  refusal,
  onSubmit,
}: {
  project: string;
  service: string;
  refusal: Refusal;
  onSubmit: (token: string) => void;
}) {
  const { t } = useTranslation("service-box-ide");
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10">
      <div className="grid w-full max-w-[530px] gap-4 rounded-sm border bg-raised p-6">
        <header className="flex items-center gap-3">
          <Mark className="size-8" />
          <div className="min-w-0">
            <h1 className="text-lg font-medium">{t("page.signIn.title")}</h1>
            <p className="truncate font-mono text-sm text-muted">
              {project}/{service}
            </p>
          </div>
        </header>
        <SignInForm refusal={refusal} onSubmit={onSubmit} />
      </div>
    </main>
  );
}

function Tree({
  client,
  project,
  service,
  path,
  depth,
  expanded,
  selected,
  toggle,
  open,
  act,
  onRefused,
}: {
  client: IdeClient;
  project: string;
  service: string;
  path: string;
  depth: number;
  expanded: ReadonlySet<string>;
  selected: string | null;
  toggle: (path: string) => void;
  open: (path: string) => void;
  act: (pending: Pending) => void;
  onRefused: (error: unknown) => void;
}) {
  const { t } = useTranslation("service-box-ide");
  const query = useQuery({
    queryKey: ["ide", project, service, "tree", path],
    queryFn: ({ signal }) => client.list(path, signal),
    retry: false,
  });

  useEffect(() => {
    if (query.isError) {
      onRefused(query.error);
    }
  }, [query.isError, query.error, onRefused]);

  if (query.isPending) {
    return <Skeleton className="mx-2 my-1 h-6" />;
  }
  if (query.isError) {
    return <p className="px-3 py-1 text-sm text-bad">{errorMessage(query.error, t)}</p>;
  }
  if (query.data.entries.length === 0) {
    return <p className="px-3 py-1 text-sm text-muted">{t("page.tree.empty")}</p>;
  }

  return (
    <ul>
      {query.data.entries.map((entry) => (
        <TreeRow
          key={entry.name}
          entry={entry}
          parent={path}
          depth={depth}
          client={client}
          project={project}
          service={service}
          expanded={expanded}
          selected={selected}
          toggle={toggle}
          open={open}
          act={act}
          onRefused={onRefused}
        />
      ))}
      {query.data.truncated && <li className="px-3 py-1 text-sm text-muted">{t("page.tree.truncated")}</li>}
    </ul>
  );
}

function TreeRow({
  entry,
  parent,
  depth,
  client,
  project,
  service,
  expanded,
  selected,
  toggle,
  open,
  act,
  onRefused,
}: {
  entry: BoxIdeEntry;
  parent: string;
  depth: number;
  client: IdeClient;
  project: string;
  service: string;
  expanded: ReadonlySet<string>;
  selected: string | null;
  toggle: (path: string) => void;
  open: (path: string) => void;
  act: (pending: Pending) => void;
  onRefused: (error: unknown) => void;
}) {
  const { t } = useTranslation("service-box-ide");
  const path = join(parent, entry.name);
  const isFolder = entry.kind === "directory";
  const isOpen = expanded.has(path);
  const isFile = entry.kind === "file";
  const icon = isFolder ? (
    isOpen ? (
      <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-muted" />
    ) : (
      <Folder aria-hidden="true" className="size-4 shrink-0 text-muted" />
    )
  ) : entry.kind === "symlink" ? (
    <Link2 aria-hidden="true" className="size-4 shrink-0 text-muted" />
  ) : (
    <FileIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
  );

  return (
    <li>
      <div
        className="group flex items-center gap-1 pr-1 hover:bg-wash data-[selected=true]:bg-wash"
        data-selected={selected === path}
        style={{ paddingLeft: `${depth * 15 + 10}px` }}
      >
        {isFolder ? (
          <ChevronRight
            aria-hidden="true"
            className={`size-4 shrink-0 text-muted transition-transform duration-[120ms] ${isOpen ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <button
          type="button"
          disabled={!isFolder && !isFile}
          title={!isFolder && !isFile ? t("page.tree.notEditable") : undefined}
          aria-expanded={isFolder ? isOpen : undefined}
          aria-label={path}
          onClick={() => (isFolder ? toggle(path) : open(path))}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left font-mono text-sm disabled:cursor-not-allowed disabled:text-muted"
        >
          {icon}
          <span className="truncate">{entry.name}</span>
        </button>
        <span className="flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("page.tree.rename", { name: entry.name })}
            tooltip={t("page.tree.rename", { name: entry.name })}
            onClick={() => act({ kind: "rename", path })}
          >
            <Pencil aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("page.tree.delete", { name: entry.name })}
            tooltip={t("page.tree.delete", { name: entry.name })}
            onClick={() => act({ kind: "delete", path, isFolder })}
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
          </Button>
        </span>
      </div>
      {isFolder && isOpen && (
        <Tree
          client={client}
          project={project}
          service={service}
          path={path}
          depth={depth + 1}
          expanded={expanded}
          selected={selected}
          toggle={toggle}
          open={open}
          act={act}
          onRefused={onRefused}
        />
      )}
    </li>
  );
}

function NameDialog({
  pending,
  onClose,
  onDone,
  client,
}: {
  pending: Extract<Pending, { kind: "file" | "folder" | "rename" }> | null;
  onClose: () => void;
  onDone: (paths: string[]) => Promise<void> | void;
  client: IdeClient;
}) {
  const { t } = useTranslation("service-box-ide");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (pending !== null) {
      setName(pending.kind === "rename" ? nameOf(pending.path) : "");
      setError(null);
    }
  }, [pending]);

  const submit = async () => {
    if (pending === null) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (pending.kind === "rename") {
        const to = join(parentOf(pending.path), name.trim());
        await client.move(pending.path, to);
        await onDone([parentOf(pending.path), parentOf(to)]);
      } else {
        const path = join(pending.parent, name.trim());
        if (pending.kind === "file") {
          await client.write(path, "", null);
        } else {
          await client.createDirectory(path);
        }
        await onDone([pending.parent]);
      }
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const title =
    pending === null
      ? ""
      : pending.kind === "rename"
        ? t("page.dialogs.rename")
        : pending.kind === "file"
          ? t("page.dialogs.newFile")
          : t("page.dialogs.newFolder");

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      size="sm"
      title={title}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("page.dialogs.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={busy} disabled={name.trim() === ""}>
            {t("page.dialogs.confirm")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error !== null && <FormBanner>{error}</FormBanner>}
        <Field label={t("page.dialogs.name")} hint={t("page.dialogs.nameHint")}>
          <Input
            mono
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

type SaveState = "idle" | "saving" | "saved" | "failed";

function Workspace({
  client,
  session,
  project,
  service,
  onRefused,
  onSignOut,
}: {
  client: IdeClient;
  session: BoxIdeSession;
  project: string;
  service: string;
  onRefused: (error: unknown) => void;
  onSignOut: () => void;
}) {
  const { t, i18n } = useTranslation("service-box-ide");
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [file, setFile] = useState<OpenFile | null>(null);
  const [notEditable, setNotEditable] = useState<{ path: string; reason: BoxIdeFile["unreadable"] } | null>(
    null,
  );
  const [opening, setOpening] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const editorRoot = useRef<HTMLDivElement>(null);
  const dirty = file !== null && file.draft !== file.saved;

  const refreshFolders = useCallback(
    async (paths: readonly string[]) => {
      await Promise.all(
        paths.map((path) =>
          queryClient.invalidateQueries({ queryKey: ["ide", project, service, "tree", path] }),
        ),
      );
    },
    [queryClient, project, service],
  );

  const open = async (path: string) => {
    setOpening(path);
    setMessage(null);
    try {
      const next = await client.read(path);
      if (next.content === null) {
        setFile(null);
        setNotEditable({ path, reason: next.unreadable });
      } else {
        setNotEditable(null);
        setFile({ path, saved: next.content, draft: next.content, version: next.version });
        setConflict(false);
        setSaveState("idle");
      }
    } catch (error) {
      onRefused(error);
      if (refusalFrom(error) === null) {
        setMessage(errorMessage(error, t));
      }
    } finally {
      setOpening(null);
    }
  };

  const save = async () => {
    if (file === null || !dirty) {
      return;
    }
    setSaveState("saving");
    setMessage(null);
    const body = file.draft;
    try {
      const { version } = await client.write(file.path, body, file.version);
      setFile((current) =>
        current === null || current.path !== file.path ? current : { ...current, saved: body, version },
      );
      setSaveState("saved");
    } catch (error) {
      onRefused(error);
      if (isApiError(error) && error.code === "ide_conflict") {
        setConflict(true);
      } else if (refusalFrom(error) === null) {
        setMessage(errorMessage(error, t));
      }
      setSaveState("failed");
    }
  };

  // Stays current between renders so the shortcut always saves what is on screen.
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const reload = async () => {
    if (file !== null) {
      await open(file.path);
    }
  };

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });

  const removePending = pending?.kind === "delete" ? pending : null;
  const namePending = pending !== null && pending.kind !== "delete" ? pending : null;
  const targetFolder = useMemo(() => {
    if (file !== null) {
      return parentOf(file.path);
    }
    return "";
  }, [file]);

  const lamp =
    saveState === "saving" ? "progress" : saveState === "failed" ? "failed" : dirty ? "degraded" : "running";

  return (
    <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-bg">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-raised px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <Mark className="size-6" />
          <h1 className="truncate font-mono text-md font-medium">
            {project}/{service}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted">
            {t("page.expires", { when: formatRelativeTime(session.expiresAt, i18n.language) })}
          </span>
          <Button variant="ghost" onClick={onSignOut}>
            {t("page.signOut")}
          </Button>
        </div>
      </header>
      <div className="grid min-h-0 grid-cols-1 md:grid-cols-[minmax(250px,350px)_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r">
          <div className="flex items-center gap-1 border-b px-2 py-1.5">
            <span className="flex-1 truncate px-1 font-mono text-sm text-muted">{t("page.tree.root")}</span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("page.dialogs.newFile")}
              tooltip={t("page.dialogs.newFile")}
              onClick={() => setPending({ kind: "file", parent: targetFolder })}
            >
              <FilePlus aria-hidden="true" className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("page.dialogs.newFolder")}
              tooltip={t("page.dialogs.newFolder")}
              onClick={() => setPending({ kind: "folder", parent: targetFolder })}
            >
              <FolderPlus aria-hidden="true" className="size-4" />
            </Button>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto py-1" aria-label={t("page.tree.label")}>
            <Tree
              client={client}
              project={project}
              service={service}
              path=""
              depth={0}
              expanded={expanded}
              selected={file?.path ?? notEditable?.path ?? null}
              toggle={toggle}
              open={open}
              act={setPending}
              onRefused={onRefused}
            />
          </nav>
        </aside>
        <section className="flex min-h-0 flex-col" ref={editorRoot}>
          {message !== null && (
            <div className="px-4 pt-3">
              <FormBanner>{message}</FormBanner>
            </div>
          )}
          {conflict && (
            <div className="grid gap-2 px-4 pt-3">
              <FormBanner>{t("page.editor.conflict")}</FormBanner>
              <div className="flex gap-2">
                <Button onClick={reload}>{t("page.editor.reload")}</Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setConflict(false);
                    setSaveState("idle");
                  }}
                >
                  {t("page.editor.keepEditing")}
                </Button>
              </div>
            </div>
          )}
          {file === null ? (
            <div className="grid flex-1 place-items-center p-6">
              {opening !== null ? (
                <Skeleton className="h-40 w-full" />
              ) : notEditable !== null ? (
                <EmptyState
                  title={t(`page.editor.${notEditable.reason === "too_large" ? "tooLarge" : "binary"}Title`, {
                    name: nameOf(notEditable.path),
                  })}
                  description={t(
                    `page.editor.${notEditable.reason === "too_large" ? "tooLarge" : "binary"}Body`,
                    {
                      max: Math.round(session.maxFileBytes / 1024),
                    },
                  )}
                />
              ) : (
                <EmptyState
                  illustration="no-services"
                  title={t("page.editor.emptyTitle")}
                  description={t("page.editor.emptyBody")}
                />
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Lamp
                    state={lamp}
                    size="md"
                    label={t(
                      `page.editor.state.${saveState === "idle" ? (dirty ? "unsaved" : "clean") : saveState}`,
                    )}
                  />
                  <span className="truncate font-mono text-sm">{file.path}</span>
                </div>
                <Button
                  variant="primary"
                  icon={<Save aria-hidden="true" className="size-4" />}
                  pending={saveState === "saving"}
                  disabledReason={dirty ? undefined : t("page.editor.nothingToSave")}
                  onClick={save}
                >
                  {t("page.editor.save")}
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <CodeEditor
                  label={file.path}
                  className="h-full"
                  language="plain"
                  value={file.draft}
                  onChange={(draft) => {
                    setFile((current) => (current === null ? current : { ...current, draft }));
                    setSaveState("idle");
                  }}
                />
              </div>
            </>
          )}
        </section>
      </div>
      <NameDialog
        client={client}
        pending={namePending}
        onClose={() => setPending(null)}
        onDone={(paths) => refreshFolders(paths)}
      />
      <ConfirmDialog
        open={removePending !== null}
        onOpenChange={(value) => {
          if (!value) {
            setPending(null);
          }
        }}
        title={t("page.dialogs.deleteTitle")}
        description={removePending === null ? "" : <span className="font-mono">{removePending.path}</span>}
        confirmLabel={t("page.dialogs.deleteConfirm")}
        onConfirm={async () => {
          if (removePending === null) {
            return;
          }
          await client.remove(removePending.path, removePending.isFolder);
          await refreshFolders([parentOf(removePending.path)]);
          if (
            file !== null &&
            (file.path === removePending.path || file.path.startsWith(`${removePending.path}/`))
          ) {
            setFile(null);
          }
          setPending(null);
        }}
      >
        <p>{t(removePending?.isFolder ? "page.dialogs.deleteFolderBody" : "page.dialogs.deleteFileBody")}</p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * The browser IDE of one box: a file tree and an editor, and nothing that runs anything. It works from
 * the token alone, so a panel session neither opens it nor is put at risk by what happens in it.
 */
export function IdePage() {
  const { t } = useTranslation("service-box-ide");
  const { project, service } = useParams({ strict: false }) as { project: string; service: string };
  const storageKey = `${STORAGE_PREFIX}${project}/${service}`;
  const [token, setToken] = useState<string | null>(() => takeTokenFromUrl() ?? readStored(storageKey));
  const [refusal, setRefusal] = useState<Refusal>("needed");
  /** Once open, the workspace stays on screen, so that a token that runs out does not lose any edits. */
  const [opened, setOpened] = useState<{ client: IdeClient; session: BoxIdeSession } | null>(null);
  /** The request for a new token can be set aside, to copy out what was being edited. */
  const [askingAside, setAskingAside] = useState(false);
  useDocumentTitle(t("page.title", { service }));

  useEffect(() => {
    const onHashChange = () => {
      const handedOver = takeTokenFromUrl();
      if (handedOver !== null) {
        setToken(handedOver);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const client = useMemo(
    () => (token === null ? null : createIdeClient(project, service, token)),
    [project, service, token],
  );

  const session = useQuery({
    queryKey: ["ide", project, service, "session", token],
    queryFn: ({ signal }) => (client as IdeClient).session(signal),
    enabled: client !== null,
    retry: false,
  });

  const refuse = useCallback(
    (error: unknown) => {
      const reason = refusalFrom(error);
      if (reason !== null) {
        setToken(null);
        setRefusal(reason);
        setAskingAside(false);
        writeStored(storageKey, null);
      }
    },
    [storageKey],
  );

  useEffect(() => {
    if (session.isError) {
      refuse(session.error);
    }
  }, [session.isError, session.error, refuse]);

  useEffect(() => {
    if (session.data !== undefined && client !== null && token !== null) {
      setOpened({ client, session: session.data });
      setRefusal("none");
      writeStored(storageKey, token);
    }
  }, [session.data, client, token, storageKey]);

  if (opened !== null) {
    return (
      <>
        <Workspace
          client={opened.client}
          session={opened.session}
          project={project}
          service={service}
          onRefused={refuse}
          onSignOut={() => {
            setToken(null);
            setOpened(null);
            setRefusal("needed");
            writeStored(storageKey, null);
          }}
        />
        <Dialog
          open={token === null && !askingAside}
          onOpenChange={(open) => setAskingAside(!open)}
          size="sm"
          title={t("page.signIn.again")}
          description={`${project}/${service}`}
        >
          <SignInForm refusal={refusal} onSubmit={setToken} />
        </Dialog>
      </>
    );
  }

  if (client === null) {
    return <SignInPage project={project} service={service} refusal={refusal} onSubmit={setToken} />;
  }
  if (session.isError) {
    return refusalFrom(session.error) !== null ? null : (
      <div className="grid min-h-dvh place-items-center bg-bg px-4">
        <ErrorState message={errorMessage(session.error, t)} onRetry={() => session.refetch()} />
      </div>
    );
  }
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4">
      <Skeleton className="h-40 w-full max-w-[650px]" />
    </div>
  );
}
