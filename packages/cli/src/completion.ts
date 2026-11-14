import type { MessageKey, Translate } from "./messages";
import type { Command } from "./shared";

/**
 * Completion scripts for bash, zsh and fish, written from the commands themselves so that they never
 * fall behind. Service names come from the panel: `opsifier __targets` lists them, quietly, and a
 * panel that can't be reached simply completes nothing.
 */

export type Shell = "bash" | "zsh" | "fish";
export const SHELLS: readonly Shell[] = ["bash", "zsh", "fish"];

const takesService = (command: Command) => /<project>(\[)?\/<service>/.test(command.args);
const flagsOf = (command: Command, globals: readonly string[]) => [
  ...Object.keys(command.options ?? {}),
  ...globals,
];

function bash(commands: readonly Command[], globals: readonly string[]): string {
  const names = commands.map((command) => command.name).join(" ");
  const flagCases = commands
    .map(
      (command) =>
        `    ${command.name}) echo "${flagsOf(command, globals)
          .map((flag) => `--${flag}`)
          .join(" ")}" ;;`,
    )
    .join("\n");
  const verbCases = commands
    .filter((command) => (command.verbs ?? []).length > 0)
    .map((command) => `    ${command.name}) echo "${(command.verbs ?? []).join(" ")}" ;;`)
    .join("\n");
  const withService = commands
    .filter(takesService)
    .map((command) => command.name)
    .join("|");
  return `# opsifier completion for bash: add  eval "$(opsifier completion bash)"  to ~/.bashrc
_opsifier_flags() {
  case "$1" in
${flagCases}
  esac
}
_opsifier_verbs() {
  case "$1" in
${verbCases}
  esac
}
_opsifier() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local command="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${names}" -- "$cur") )
    return
  fi
  case "$cur" in
    -*)
      COMPREPLY=( $(compgen -W "$(_opsifier_flags "$command")" -- "$cur") )
      return
      ;;
  esac
  local words=""
  if [ "$COMP_CWORD" -eq 2 ]; then
    words="$(_opsifier_verbs "$command")"
  fi
  case "$command" in
    ${withService === "" ? "__none__" : withService})
      words="$words $(opsifier __targets 2>/dev/null)"
      ;;
  esac
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -o default -F _opsifier opsifier
`;
}

/** zsh runs the bash completion through its own bashcompinit: one script to keep right, not two. */
function zsh(commands: readonly Command[], globals: readonly string[]): string {
  return `# opsifier completion for zsh: add  eval "$(opsifier completion zsh)"  to ~/.zshrc
autoload -U +X compinit && compinit
autoload -U +X bashcompinit && bashcompinit
${bash(commands, globals).split("\n").slice(1).join("\n")}`;
}

const fishQuote = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function fish(commands: readonly Command[], globals: readonly string[], t: Translate): string {
  const lines = [
    "# opsifier completion for fish: opsifier completion fish > ~/.config/fish/completions/opsifier.fish",
    "complete -c opsifier -f",
  ];
  for (const command of commands) {
    lines.push(
      `complete -c opsifier -n __fish_use_subcommand -a ${command.name} -d ${fishQuote(t(`cmd.${command.name}` as MessageKey))}`,
    );
    for (const [name, option] of Object.entries(command.options ?? {})) {
      lines.push(
        `complete -c opsifier -n '__fish_seen_subcommand_from ${command.name}' -l ${name}${option.type === "string" ? " -r" : ""} -d ${fishQuote(t(option.description))}`,
      );
    }
    if ((command.verbs ?? []).length > 0) {
      lines.push(
        `complete -c opsifier -n '__fish_seen_subcommand_from ${command.name}' -a ${fishQuote((command.verbs ?? []).join(" "))}`,
      );
    }
    if (takesService(command)) {
      lines.push(
        `complete -c opsifier -n '__fish_seen_subcommand_from ${command.name}' -a '(opsifier __targets 2>/dev/null)'`,
      );
    }
  }
  for (const name of globals) {
    lines.push(`complete -c opsifier -l ${name}`);
  }
  return `${lines.join("\n")}\n`;
}

export function completionScript(
  shell: Shell,
  commands: readonly Command[],
  globals: readonly string[],
  t: Translate,
): string {
  const visible = commands.filter((command) => command.group !== "hidden");
  if (shell === "fish") {
    return fish(visible, globals, t);
  }
  return shell === "zsh" ? zsh(visible, globals) : bash(visible, globals);
}
