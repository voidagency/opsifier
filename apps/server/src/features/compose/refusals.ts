import type { ComposeIssue } from "@opsifier/contract";
import { conflict } from "../../core/errors";
import { foreignNetworkRefusal } from "../projects/network";
import type { WritableInContext } from "./contexts";
import type { HeldByRunning, LinkedMount } from "./own-folder";

const SEE_SOURCE = "See the Source tab.";

/** A name of the same sense that the proxy can never be looking for elsewhere. */
function suggestedName(name: string): string {
  const plain = name.replaceAll("_", "-").replace(/-{2,}/g, "-");
  return /^opsifier/i.test(plain) ? `app-${plain}` : plain;
}

function nameRefusal(issue: ComposeIssue, stack: string): string {
  const who = issue.service ?? "A service";
  const detail = issue.detail ?? "";
  const taken = "a name another project's service or the panel may answer to on the proxy's network";
  if (detail.startsWith("container_name: ")) {
    return `${who} sets ${detail}, ${taken}. Leave container_name out, or start it with ${stack}-.`;
  }
  if (detail.startsWith("hostname: ")) {
    return `${who} sets ${detail}, ${taken}. Give it a hostname without an underscore that doesn't start with opsifier, or leave hostname out.`;
  }
  if (detail.startsWith("aliases: ")) {
    return `${who} asks for the alias ${detail.slice("aliases: ".length)}, ${taken}. Remove it: a child takes no alias on the proxy's network, and elsewhere an alias has no underscore and doesn't start with opsifier.`;
  }
  return `${who} is ${taken}. Rename it without an underscore and not starting with opsifier, such as ${suggestedName(detail)}.`;
}

const KEEP_CLEAR =
  "A container can replace anything inside a folder it mounts, so mount a folder that holds no other mount, none of the files the stack is read from (its Compose files, .env and env files) and nothing a build uses.";

function mountRefusal(issue: ComposeIssue): string {
  const who = issue.service ?? "A secret, config or volume of the stack";
  const detail = issue.detail ?? "";
  if (detail === ".") {
    return `${who} mounts the stack's own folder, where a container could rewrite the stack's files and change where its other mounts lead. Mount a subfolder of the stack instead of the stack's own folder.`;
  }
  const building = /^([a-z_]+): (.*) \(holds (.*)\)$/.exec(detail);
  if (building !== null) {
    const [, field, path, held] = building;
    return field === "cache_to"
      ? `${who} writes its build cache to ${path}, which holds ${held}: the build would write there while containers can change it. Write the cache to a folder of its own.`
      : `${who} builds from ${path} (its ${field}), which holds ${held}, a folder or file a container mounts: the build reads it while the container can still change it. Build from a folder that holds no mount.`;
  }
  const being = /^(.*) \(is the (.*)\)$/.exec(detail);
  if (being !== null) {
    return `${who} mounts ${being[1]}, which is the ${being[2]}. ${KEEP_CLEAR}`;
  }
  const holding = /^(.*) \(holds (.*)\)$/.exec(detail);
  if (holding !== null) {
    return `${who} mounts ${holding[1]}, which holds ${holding[2]}. ${KEEP_CLEAR}`;
  }
  return `${who} mounts ${detail}, a file the stack is read from, which a container could rewrite before the stack starts. Keep the stack's own files out of its mounts.`;
}

/** A mount, or what a build uses, whose path goes through anything but folders, found before anything runs. */
export function linkedMountRefusal(linked: LinkedMount): Error {
  const who = linked.service ?? "A secret, config or volume of the stack";
  const where = `./${linked.at}`;
  const build = linked.field !== undefined;
  const why =
    linked.kind === "link"
      ? `${where} is a link, which ${build ? "the build" : "Docker"} would follow wherever it leads. ${build ? "Build from" : "Mount"} the folder it points to instead, or replace the link with a folder.`
      : linked.kind === "not_a_folder"
        ? `${where} is not a folder.`
        : `${where} is neither a folder nor a file.`;
  const what = build ? `builds from ./${linked.path}, its ${linked.field},` : `mounts ./${linked.path},`;
  return conflict("compose_invalid", `This Compose file can't run: ${who} ${what} but ${why}`);
}

/** A context a build walks, that holds a folder a child can write, which nothing leaves out. */
export function writableInContextRefusal({ context, mount, path }: WritableInContext): Error {
  const where = context.path === mount.path ? "." : `./${path}`;
  return conflict(
    "compose_invalid",
    `This Compose file can't run: ${context.service} builds from a ${context.field === "context" ? "context" : "context it adds"} that holds ${where}, a folder ${mount.service ?? "the stack"} mounts read-write. A build walks its context and then opens what it found by name, while a container could have put a link there in between. Add ${path} to the .dockerignore of that context, or mount it read-only (:ro).`,
  );
}

/** A file the stack is read from whose path goes through anything but folders. */
export function linkedFileRefusal(linked: LinkedMount): Error {
  const where = `./${linked.at}`;
  const why =
    linked.kind === "link"
      ? `is reached through a link at ${where}, which Compose would follow wherever it leads. Replace the link with the file itself`
      : linked.kind === "not_a_folder"
        ? `can't be read: ${where} is not a folder`
        : "is neither a folder nor a file";
  return conflict(
    "compose_invalid",
    `This Compose file can't run: ./${linked.path}, a file the stack is read from, ${why}.`,
  );
}

/** A container of the last deploy that could still change what the new one is about to read or mount. */
export function runningHoldsRefusal(held: HeldByRunning): Error {
  const what = held.path === "." ? "the stack's own folder" : `./${held.path}`;
  const held_ = held.holds === "." ? "the stack's own folder" : `./${held.holds}`;
  if (held.fromContext !== undefined) {
    return conflict(
      "compose_invalid",
      `This stack can't deploy while ${held.child} (${held.container}) runs: since its last deploy it writes in ${what}, inside ${held_}, which a build of the stack as it is now walks, and it keeps running until Compose has pulled and built everything. Add ${held.fromContext} to the .dockerignore of that context, mount it read-only, or stop the stack, then deploy.`,
    );
  }
  const where = held.insideBuild
    ? `inside ${held_}, which a build of the stack as it is now reads`
    : `which holds ${held_} of the stack as it is now`;
  return conflict(
    "compose_invalid",
    `This stack can't deploy while ${held.child} (${held.container}) runs: since its last deploy it mounts ${what}, ${where}, and it keeps running until Compose has pulled and built everything. Stop the stack, then deploy.`,
  );
}

/**
 * What stops a file from running, in the words a person needs to fix it. Every refusal here is the
 * same whether the page, a file the stack brings in, or what Compose resolved said it: no confirmation
 * makes any of them acceptable.
 */
export function fileRefusal(issue: ComposeIssue, stack: string): Error {
  switch (issue.code) {
    case "foreign_network":
      return foreignNetworkRefusal(issue.detail ?? "another network");
    case "foreign_name":
      return conflict("compose_invalid", `This Compose file can't run: ${nameRefusal(issue, stack)}`);
    case "mounts_stack":
      return conflict("compose_invalid", `This Compose file can't run: ${mountRefusal(issue)}`);
    case "escapes_stack": {
      const brought = /^(include|include env_file|include project_directory|extends file): (.*\$.*)$/.exec(
        issue.detail ?? "",
      );
      if (brought !== null) {
        return conflict(
          "compose_invalid",
          `This Compose file can't run: it names what it brings in through a variable (${brought[1]}: ${brought[2]}), which Compose would fill in, then read or fetch while it loads the stack, before anything could check it. Write the path out.`,
        );
      }
      const folder = /^include project_directory: (.*)$/.exec(issue.detail ?? "");
      if (folder !== null) {
        return conflict(
          "compose_invalid",
          `This Compose file can't run: an include reads the paths of its file from ${folder[1]}, outside the stack's folder (Compose takes an absolute folder, or one under ~, as it is). Name a folder of the stack, relative to the file that includes it.`,
        );
      }
      if (issue.detail?.startsWith("build.ssh: ") === true) {
        return conflict(
          "compose_invalid",
          `This Compose file can't run: the build of ${issue.service ?? "a service"} names the SSH keys it forwards in a form the panel can't read (${issue.detail.slice("build.ssh: ".length)}), so it can't tell which files of the server they are. Write them as a list of id=path entries, or as a mapping of ids to paths.`,
        );
      }
      return conflict(
        "compose_invalid",
        `This Compose file can't run: escapes_stack${issue.detail === null ? "" : ` (${issue.detail})`}. ${SEE_SOURCE}`,
      );
    }
    case "bind_volume":
      return conflict(
        "compose_invalid",
        `This Compose file can't run: its volume ${issue.detail ?? ""} binds a folder of the server through its driver options, which Compose keeps as it was made even when the file changes. Mount the folder with a bind in the service's volumes instead.`,
      );
    default:
      return conflict(
        "compose_invalid",
        `This Compose file can't run: ${issue.code}${issue.detail === null ? "" : ` (${issue.detail})`}. ${SEE_SOURCE}`,
      );
  }
}
