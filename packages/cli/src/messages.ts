import type { Locale } from "@opsifier/client";

const en = {
  "help.title":
    "opsifier: the command line for an Opsifier panel. Every command is a call to the panel's API.",
  "help.usage": "Usage: opsifier <command> [arguments] [options]",
  "help.everyday": "Everyday",
  "help.longTail": "Anything else",
  "help.options": "Options",
  "help.environment": "Environment",
  "help.env.url": "the panel's address, for example https://panel.example.com",
  "help.env.key": "an API key, created in Settings, API keys. It is never read from an argument.",
  "help.outputNote":
    "Output is JSON when stdout is not a terminal, and text at a terminal. --json and --text override that.",
  "help.more": "opsifier <command> --help describes one command.",
  "help.exitCodes":
    "Exit codes: 0 done, 1 failed, 2 invalid use, 3 not authenticated, 4 forbidden, 5 not found, 6 conflict, 7 panel unreachable.",

  "cmd.whoami": "Show who this key speaks for and what it reaches",
  "cmd.projects": "List projects and the state of their services",
  "cmd.services": "List one project's services and their state",
  "cmd.status": "Show the state of everything, of one project, or of one service",
  "cmd.logs": "Read a service's recent log lines",
  "cmd.deployments": "List a service's recent deployments",
  "cmd.deploy": "Deploy a service",
  "cmd.restart": "Restart a service's tasks",
  "cmd.start": "Start a stopped service",
  "cmd.stop": "Stop a service. Its domains answer 503 until it starts again",
  "cmd.destroy": "Remove a service. Its named volumes and backups are kept",
  "cmd.delete-project": "Delete an empty project",
  "cmd.actions": "List actions, newest first",
  "cmd.action": "Show one action and its output",
  "cmd.cancel": "Cancel an action",
  "cmd.api": "Call any operation of the API",

  "flag.json": "Print JSON, whatever stdout is",
  "flag.text": "Print text, whatever stdout is",
  "flag.help": "Describe this command",
  "flag.force": "Skip every build cache",
  "flag.yes": "Confirm that this should really happen",
  "flag.confirm": "The exact name of what is being removed",
  "flag.follow": "Keep showing new lines, until interrupted",
  "flag.since": "How far back to look: 45s, 15m, 2h or 1d",
  "flag.grep": "Keep only lines containing this text",
  "flag.stream": "all, stdout or stderr",
  "flag.level": "any, error, warn, info or debug",
  "flag.limit": "How many entries at most",
  "flag.project": "Only this project",
  "flag.service": "Only this service",
  "flag.status": "queued, running, succeeded, failed or cancelled",
  "flag.type": "Only this type of action",
  "flag.cursor": "Continue from the next-page value of an earlier answer",
  "flag.query": "A query parameter, as name=value. Repeat for several",
  "flag.data": "The JSON body, or @file, or @- for standard input",

  "state.undeployed": "undeployed",
  "state.stopped": "stopped",
  "state.starting": "starting",
  "state.running": "running",
  "state.failing": "failing",
  "state.unknown": "unknown",

  "col.project": "PROJECT",
  "col.service": "SERVICE",
  "col.type": "TYPE",
  "col.state": "STATE",
  "col.replicas": "REPLICAS",
  "col.lastDeploy": "LAST DEPLOY",
  "col.work": "IN PROGRESS",
  "col.status": "STATUS",
  "col.action": "ACTION",
  "col.target": "TARGET",
  "col.started": "STARTED",
  "col.id": "ID",
  "col.method": "METHOD",
  "col.path": "PATH",
  "col.kind": "KIND",
  "col.summary": "SUMMARY",

  "empty.projects": "No projects here yet.",
  "empty.project": "This project has no services yet.",
  "empty.actions": "No actions to show.",
  "empty.logs": "No log lines to show.",
  "empty.deployments": "No deployments yet.",
  "empty.operations": "No operation matches.",

  "field.panel": "Panel",
  "field.key": "Key",
  "field.user": "Account",
  "field.reach": "Reach",
  "field.type": "Type",
  "field.source": "Source",
  "field.address": "Address",
  "field.lastDeploy": "Last deploy",
  "field.recent": "Recent deploys",
  "field.inProgress": "In progress",
  "field.created": "Created",
  "field.started": "Started",
  "field.finished": "Finished",
  "field.by": "By",
  "field.error": "Error",
  "field.output": "Output",
  "whoami.keyLine": "{name}, {level}, expires {expires}",
  "whoami.keyLineNever": "{name}, {level}, no expiry",
  "whoami.session": "a browser session",
  "whoami.everyProject": "every project",
  "whoami.noProject": "no project yet",

  "deploy.queued": "{target}: deployment queued as action {action} ({status}).",
  "restart.queued": "{target}: restart queued as action {action} ({status}).",
  "start.queued": "{target}: start queued as action {action} ({status}).",
  "stop.queued": "{target}: stop queued as action {action} ({status}).",
  "destroy.queued": "{target}: removal queued as action {action} ({status}).",
  "deleteProject.queued": "{project}: deletion queued as action {action} ({status}).",
  "action.cancelled": "Action {action}: {status}.",
  "next.check": "See how it is going: opsifier action {action}",

  "error.prefix": "Error",
  "error.hint": "Hint",
  "warn.plainHttp": "Warning: OPSIFIER_URL uses plain HTTP, so the API key can be read on the way to {host}.",
  "warn.pollFailed": "Could not read new lines ({reason}). Trying again.",

  "usage.unknownCommand": 'Unknown command "{name}".',
  "usage.keyFlag": "API keys are only read from OPSIFIER_API_KEY, never from an argument.",
  "usage.target": 'Give the service as project/service, for example shop/web, not "{value}".',
  "usage.missingArgument": "Missing argument: {name}.",
  "usage.extraArgument": 'Unexpected argument: "{value}".',
  "usage.duration": 'Not a duration: "{value}". Use for example 45s, 15m, 2h or 1d.',
  "usage.limit": 'Not a positive whole number: "{value}".',
  "usage.query": 'A query parameter is written name=value, not "{value}".',
  "usage.json": "This is not valid JSON: {reason}",
  "usage.dataFile": 'Could not read "{file}": {reason}',
  "confirm.stop": "This takes {target} offline. Run it again with --yes to confirm.",
  "confirm.destroy":
    "This removes {target} and everything it runs. Run it again with --confirm {name} to confirm.",
  "confirm.project": "This deletes project {name}. Run it again with --confirm {name} to confirm.",
  "confirm.api":
    "This operation cannot be undone or takes something offline. Run it again with --yes to confirm.",

  "help.setup": "Set up a folder",
  "help.env.service": "the service a command acts on when it names none, as project/service",
  "help.target":
    "A command that acts on one service takes it as project/service. Without one, it uses OPSIFIER_SERVICE, then the folder linked with opsifier link.",

  "cmd.link": "Link this folder to a service, so that commands run here act on it",
  "cmd.unlink": "Remove this folder's link",
  "cmd.releases": "List the versions a service keeps, the running one marked",
  "cmd.rollback": "Run an earlier version again, from the image kept on the server",
  "cmd.config": "List a service's variables, or get, set and unset them",
  "cmd.open": "Show a service's address, as a link the terminal can open",

  "flag.wait": "Wait for the end, showing its output, and fail if it fails",
  "flag.deploy": "Deploy the service once the variables are saved",
  "flag.envProject": "The variables a project shares with all its services, instead of one service's",
  "flag.confirmRollback": "The service's exact name, to confirm going back",

  "col.version": "VERSION",
  "col.image": "IMAGE",
  "col.commit": "COMMIT",
  "col.by": "BY",
  "col.created": "CREATED",
  "col.note": "NOTE",

  "empty.releases": "No versions kept yet: deploy the service first.",
  "empty.releasesUnavailable":
    "This service keeps no versions: databases and Compose stacks don't, nor does a service not deployed since versions began.",
  "empty.config": "{target} has no variables.",

  "release.running": "running",
  "release.rollbackOf": "rollback to v{version}",
  "refusal.active": "running",
  "refusal.not_deployed": "never ran",
  "refusal.renamed": "the service was renamed since",
  "refusal.image_missing": "image no longer on the server",
  "refusal.image_altered": "image changed since",
  "refusal.volumes_differ": "volumes differ since",

  "link.done": "This folder now acts on {service} on {panel}. The link is in {file}.",
  "unlink.done": "Removed {file}.",
  "unlink.none": "This folder has no link ({file}).",

  "rollback.queued": "{target}: going back to v{version}, as action {action} ({status}).",
  "rollback.none": "{target} keeps no earlier version that can run again. See opsifier releases.",
  "rollback.unknown": "No version v{version} is kept. See opsifier releases.",
  "rollback.chooseVersion":
    "The panel can't vouch for which version of {target} is running. Name the one to go back to: opsifier releases lists them.",

  "config.hidden": "Values stay hidden: opsifier config get NAME --yes shows one.",
  "config.saved": "{target}: saved {names}.",
  "config.removed": "{target}: removed {names}.",
  "config.unchanged": "{target}: nothing to change.",
  "config.wasNotSet": "{target}: {names} was not set.",
  "config.notFound": "{target} has no variable {names}.",
  "config.applyHint": "It applies at the next deployment: opsifier deploy {target}",
  "config.applyHintProject": "It applies at the next deployment of each service in {project}.",

  "open.none": "{target} has no address yet: give it a domain first.",

  "wait.following": "{title} on {target}, action {action}:",
  "wait.succeeded": "{title} on {target}: succeeded in {duration}.",
  "wait.failed":
    "{title} on {target} did not succeed ({status}): {reason}. Details: opsifier action {action}",
  "wait.detached": "Stopped waiting. It goes on at the panel: opsifier action {action}",

  "usage.targetFrom": 'The service in {source} is "{value}", which is not project/service.',
  "usage.noTarget":
    "Name the service as project/service, set OPSIFIER_SERVICE, or link this folder with opsifier link project/service.",
  "usage.linkPanel":
    "{file} links this folder to {service} on {panel}, but this command talks to {current}. Log in to {panel}, set OPSIFIER_URL to it, or link the folder again.",
  "usage.version": 'Not a version: "{value}". Use the number opsifier releases shows, such as 4 or v4.',
  "usage.envName":
    'Not a variable name: "{value}". Use letters, digits, _ . and -, not starting with a digit.',
  "usage.envPair": 'Write each variable as NAME=value, not "{value}".',
  "usage.envNewline": "{name}: a value can't hold a line break.",
  "usage.projectAndService": "Name a service or give --project, not both.",
  "usage.deployProject": "--deploy goes with one service's variables, not with --project.",
  "usage.waitWithoutDeploy": "--wait goes with --deploy here.",

  "confirm.rollback":
    "This runs v{version} ({image}) on {target} instead of what runs now. Run it again with --confirm {name} to confirm.",
  "confirm.reveal":
    "This prints secret values of {target}, and the panel records that it did. Run it again with --yes to confirm.",
  "confirm.unset": "This removes {names} from {target}. Run it again with --yes to confirm.",

  "help.login":
    "Or log in once: opsifier login https://panel.example.com keeps the key in your configuration folder.",
  "cmd.login": "Keep an API key for a panel, so that commands need no environment variables",
  "cmd.logout": "Forget the key kept for a panel",
  "cmd.create": "Create a project, or a service in one, with its source",
  "cmd.push": "Send this folder's code to a service and deploy it",

  "flag.image": "Run this image, for example nginx:1.27",
  "flag.git": "Build from this Git repository",
  "flag.ref": "The branch, tag or commit to build. main when not given",
  "flag.gitPath": "The folder to build from, inside the repository. / when not given",
  "flag.dockerfile": "Build from this Dockerfile, read on this machine",
  "flag.database": "A database instead of an app: postgres, mysql, mariadb, mongo or redis",
  "flag.link": "Link this folder to the new service",
  "flag.deployCreated": "Deploy the new service at once",
  "flag.dir": "The folder to send. The linked folder, or this one, when not given",
  "flag.uploadPath": "The folder to build from, inside what is sent. / when not given",
  "flag.uploadOnly": "Send the code without deploying it",

  "auth.keyWithoutUrl":
    "OPSIFIER_API_KEY is set but OPSIFIER_URL is not. Set both, or neither and log in with opsifier login.",
  "auth.none": "No panel to talk to: OPSIFIER_URL is not set, and opsifier login has kept no key.",
  "auth.noKeyFor":
    "No API key for {panel}: OPSIFIER_API_KEY is not set, and opsifier login has kept none for it.",
  "hint.notConfigured":
    "Log in once with opsifier login https://panel.example.com, or set OPSIFIER_URL and OPSIFIER_API_KEY.",
  "warn.credentialsExposed":
    "Warning: other users of this machine can read {file}. Make it yours alone: chmod 600 {file}",

  "login.prompt": "API key for {panel} (Settings, API keys): ",
  "login.done":
    "Logged in to {panel} as {user}. Commands talk to this panel unless OPSIFIER_URL names another.",
  "login.kept": "The key is kept in {file}, readable by you only.",
  "logout.nowhere": "No panel is logged in to.",
  "logout.none": "No key is kept for {panel}.",
  "logout.done": "Forgot the key for {panel}.",
  "logout.revoke": "The key itself works until it is revoked in the panel, under Settings, API keys.",

  "usage.loginAddress": "Give the panel's address: opsifier login https://panel.example.com",
  "usage.loginKey": "No API key was given.",
  "usage.projectOnly":
    "{project} is a project: a source, --link and --deploy go with a service, as {project}/<service>.",
  "usage.oneSource": "Give one source: --image, --git, --dockerfile or --database.",
  "usage.refWithoutGit": "--ref and --path go with --git.",
  "usage.engine": 'Not a database engine: "{value}". Use one of {engines}.',
  "usage.deployWithoutSource":
    "--deploy needs a source: --image, --git, --dockerfile or --database. Without one, send code with opsifier push.",
  "usage.notAFolder": "{folder} is not a folder.",

  "create.project": "Created project {project}.",
  "create.service": "Created {target}.",
  "create.database": "Created {target}, a {engine} database. The panel generated its credentials.",
  "create.linked": "This folder is linked to {target}.",
  "create.nextPush": "Next: opsifier push {target} sends a folder's code and deploys it.",
  "create.nextDeploy": "Next: opsifier deploy {target} --wait",

  "confirm.pushReplaces":
    "{target} deploys from {source}. Sending this folder replaces that source. Run it again with --yes to confirm.",

  "push.empty": "Nothing to send from {folder}: every file is ignored, or there is none.",
  "push.tooLarge":
    "The archive is {size}, more than the {max} the panel accepts. Leave more out with .opsifierignore.",
  "push.skipped": "Left out, as the panel would refuse them: {paths}",
  "push.packed": "Packed {files} files from {folder} ({size}, {compressed} compressed).",
  "push.uploaded": "Sent to {target}.",
  "push.nextDeploy": "Deploy it: opsifier deploy {target} --wait",

  "cmd.ps": "Show a service's state and what it uses: processor, memory, network",
  "cmd.domains": "List a service's domains, or add, remove and choose the primary one",
  "cmd.maintenance": "Show, turn on or turn off a service's maintenance page",
  "cmd.db": "Show a database's credentials, or print its address or password",
  "cmd.scripts": "List a service's scripts, or add and remove them",
  "cmd.run": "Run a saved script in the service's container, and show its output",
  "cmd.backups": "List a service's backups, or take one now",

  "flag.port": "The port the service listens on, inside its container. 80 when not given",
  "flag.domainPath": "Only this path of the domain, such as /api",
  "flag.primary": "Make it the service's primary address",
  "flag.http": "Plain HTTP only, with no certificate",
  "flag.title": "The maintenance page's title",
  "flag.subtitle": "The line under the title",
  "flag.external": "The address from outside the server, instead of inside the project",
  "flag.root": "The administrator's password, instead of the application user's",
  "flag.command": "The script itself, run with sh in the service's container",
  "flag.file": "A file on this machine holding the script",
  "flag.cron": 'Run it on this schedule, such as "0 3 * * *"',
  "flag.tz": "The time zone of the schedule, such as Europe/Paris. UTC when not given",
  "flag.afterDeploy": "Run it after every successful deployment",
  "flag.detach": "Start it and return, without waiting for its output",

  "col.address": "ADDRESS",
  "col.port": "PORT",
  "col.primary": "PRIMARY",
  "col.name": "NAME",
  "col.schedule": "SCHEDULE",
  "col.afterDeploy": "AFTER DEPLOY",
  "col.lastRun": "LAST RUN",
  "col.what": "WHAT",
  "col.size": "SIZE",
  "col.where": "WHERE",

  "empty.domains": "No domains yet: opsifier domains add <host> gives the service one.",
  "empty.scripts": "No scripts yet: opsifier scripts add <name> --command <script> saves one.",
  "empty.backups": "No backups yet.",

  "field.engine": "Engine",
  "field.dbUser": "User",
  "field.dbName": "Database",
  "field.inside": "Inside the project",
  "field.outside": "From outside",
  "field.url": "Address",
  "field.warning": "Warning",
  "field.cpu": "Processor",
  "field.memory": "Memory",
  "field.network": "Network",
  "field.readAt": "Read at",

  "domains.unknown": "No domain {host} on this service. See opsifier domains.",
  "domains.primaryMark": "yes",
  "domains.added": "{target} now answers at {url}.",
  "domains.addedPrimary": "{target} now answers at {url}, its primary address.",
  "domains.dns": "Point {host} at this server in its DNS: the certificate comes once it answers there.",
  "domains.removed": "Removed {url}.",
  "domains.madePrimary": "{url} is now the primary address of {target}.",

  "maintenance.isOn": "{target}: maintenance page on ({title}).",
  "maintenance.isOff": "{target}: maintenance page off.",
  "maintenance.turnedOn": "{target}: maintenance page on. The service itself keeps running.",
  "maintenance.turnedOff": "{target}: maintenance page off, the service answers again.",

  "db.rotationUnresolved": "a password change did not finish: see the service in the panel",
  "db.notExposed": "not reachable from outside",

  "scripts.yes": "yes",
  "scripts.added": "Saved script {name} on {target}.",
  "scripts.runHint": "Run it: opsifier run {name}",
  "scripts.unknown": "{target} has no script {name}. See opsifier scripts.",
  "scripts.removed": "Removed script {name} from {target}.",

  "run.queued": "{target}: script {name} queued as action {action} ({status}).",
  "run.detached": "Stopped waiting. The script goes on: opsifier action {action}",
  "run.succeeded": "{name}: done in {duration}.",
  "run.failed": "{name} did not succeed ({status}, exit code {code}): {reason}",

  "backups.config": "Setting {id}: {what}, {schedule}, to {where}, next {next}",
  "backups.unknown": "{target} has no backup setting {id}. See opsifier backups.",
  "backups.none": "{target} has no backup setting yet: create one in the panel, under Backups.",
  "backups.queued": "{target}: backup queued as action {action} ({status}).",

  "ps.noReadings": "No readings yet: they come once the service runs.",
  "ps.memoryOf": "{used} of {limit}",
  "ps.network": "in {rx}, out {tx}",

  "usage.port": 'Not a port: "{value}". Use a number from 1 to 65535.',
  "usage.host":
    'Give a host such as example.com, or a whole address such as https://example.com/api, not "{value}".',
  "usage.domainPath": "{host} has several paths ({paths}): name one with --path.",
  "usage.scriptBody": "Give the script with --command, or a file holding it with --file.",
  "usage.tzWithoutCron": "--tz goes with --cron.",
  "usage.backupConfig": "This service has several backup settings: name one of {ids}.",

  "confirm.removeDomain": "This removes {url} from {target}. Run it again with --yes to confirm.",
  "confirm.maintenance":
    "This shows the maintenance page instead of {target} to every visitor. Run it again with --yes to confirm.",
  "confirm.revealSecret":
    "This prints a secret of {target}, and the panel records that it did. Run it again with --yes to confirm.",
  "confirm.removeScript": "This removes script {name} from {target}. Run it again with --yes to confirm.",

  "cmd.completion": "Print the completion script of a shell: bash, zsh or fish",
  "cmd.__targets": "List every service as project/service, one per line, for completion scripts",
  "usage.shell": 'No completion for "{value}": use bash, zsh or fish.',

  "flag.includeSecrets": "Send files whose names suggest secrets, such as .env, as well",
  "push.interrupted": "Interrupted: nothing more was sent, and no deployment was started.",
  "push.notAProject":
    "{folder} is not a project folder: a home folder, the root and the folders above this command line's keys are never sent. Run it from the project, or link the project's folder.",
  "push.secretsRefused":
    "These files may hold secrets: {paths}. Leave them out in .gitignore or .opsifierignore, or run it again with --include-secrets to send them.",
  "push.secretsIncluded": "Sending files that may hold secrets, as asked: {paths}",
  "usage.waitWithUploadOnly": "--wait follows the deployment, which --upload-only leaves out.",
  "usage.loginExtra":
    "opsifier login takes the panel's address only. The key is asked for, never given as an argument.",
  "usage.loginAddressInvalid": "That is not a panel's address. Give one such as https://panel.example.com.",
  "login.reused":
    "Logged in to {panel} as {user}, with the key already kept for it. Commands talk to this panel unless OPSIFIER_URL names another.",
  "logout.choose":
    "No panel is current now. Keys are still kept for {panels}: opsifier login <address> uses one again.",
  "wait.gaveUp":
    "The panel has not answered for five minutes. The work may still be going on: opsifier action {action}",
  "scripts.changed":
    "The list of scripts changed while {name} was being removed. Check it with opsifier scripts.",
} as const;

export type MessageKey = keyof typeof en;

const fr: Record<MessageKey, string> = {
  "help.title":
    "opsifier : la ligne de commande d'un panneau Opsifier. Chaque commande est un appel à l'API du panneau.",
  "help.usage": "Utilisation : opsifier <commande> [arguments] [options]",
  "help.everyday": "Au quotidien",
  "help.longTail": "Tout le reste",
  "help.options": "Options",
  "help.environment": "Environnement",
  "help.env.url": "l'adresse du panneau, par exemple https://panel.example.com",
  "help.env.key": "une clé API, créée dans Réglages, Clés API. Elle n'est jamais lue dans un argument.",
  "help.outputNote":
    "La sortie est en JSON quand stdout n'est pas un terminal, et en texte dans un terminal. --json et --text forcent l'un ou l'autre.",
  "help.more": "opsifier <commande> --help décrit une commande.",
  "help.exitCodes":
    "Codes de sortie : 0 fait, 1 échec, 2 mauvaise utilisation, 3 non authentifié, 4 interdit, 5 introuvable, 6 conflit, 7 panneau injoignable.",

  "cmd.whoami": "Afficher au nom de qui parle cette clé et ce qu'elle atteint",
  "cmd.projects": "Lister les projets et l'état de leurs services",
  "cmd.services": "Lister les services d'un projet et leur état",
  "cmd.status": "Afficher l'état de tout, d'un projet ou d'un service",
  "cmd.logs": "Lire les dernières lignes de journal d'un service",
  "cmd.deployments": "Lister les derniers déploiements d'un service",
  "cmd.deploy": "Déployer un service",
  "cmd.restart": "Redémarrer les tâches d'un service",
  "cmd.start": "Démarrer un service arrêté",
  "cmd.stop": "Arrêter un service. Ses domaines répondent 503 jusqu'à son redémarrage",
  "cmd.destroy": "Supprimer un service. Ses volumes nommés et ses sauvegardes sont conservés",
  "cmd.delete-project": "Supprimer un projet vide",
  "cmd.actions": "Lister les actions, les plus récentes d'abord",
  "cmd.action": "Afficher une action et sa sortie",
  "cmd.cancel": "Annuler une action",
  "cmd.api": "Appeler n'importe quelle opération de l'API",

  "flag.json": "Afficher du JSON, quelle que soit la sortie",
  "flag.text": "Afficher du texte, quelle que soit la sortie",
  "flag.help": "Décrire cette commande",
  "flag.force": "Ignorer tous les caches de build",
  "flag.yes": "Confirmer que cela doit vraiment se faire",
  "flag.confirm": "Le nom exact de ce qui est supprimé",
  "flag.follow": "Continuer à afficher les nouvelles lignes, jusqu'à interruption",
  "flag.since": "Jusqu'où remonter : 45s, 15m, 2h ou 1d",
  "flag.grep": "Ne garder que les lignes contenant ce texte",
  "flag.stream": "all, stdout ou stderr",
  "flag.level": "any, error, warn, info ou debug",
  "flag.limit": "Combien d'éléments au plus",
  "flag.project": "Seulement ce projet",
  "flag.service": "Seulement ce service",
  "flag.status": "queued, running, succeeded, failed ou cancelled",
  "flag.type": "Seulement ce type d'action",
  "flag.cursor": "Reprendre à la valeur de page suivante d'une réponse précédente",
  "flag.query": "Un paramètre de requête, sous la forme nom=valeur. À répéter si besoin",
  "flag.data": "Le corps JSON, ou @fichier, ou @- pour l'entrée standard",

  "state.undeployed": "non déployé",
  "state.stopped": "arrêté",
  "state.starting": "en démarrage",
  "state.running": "en marche",
  "state.failing": "en échec",
  "state.unknown": "inconnu",

  "col.project": "PROJET",
  "col.service": "SERVICE",
  "col.type": "TYPE",
  "col.state": "ÉTAT",
  "col.replicas": "RÉPLIQUES",
  "col.lastDeploy": "DERNIER DÉPLOIEMENT",
  "col.work": "EN COURS",
  "col.status": "STATUT",
  "col.action": "ACTION",
  "col.target": "CIBLE",
  "col.started": "DÉBUT",
  "col.id": "ID",
  "col.method": "MÉTHODE",
  "col.path": "CHEMIN",
  "col.kind": "NATURE",
  "col.summary": "RÉSUMÉ",

  "empty.projects": "Aucun projet pour l'instant.",
  "empty.project": "Ce projet n'a pas encore de service.",
  "empty.actions": "Aucune action à afficher.",
  "empty.logs": "Aucune ligne de journal à afficher.",
  "empty.deployments": "Aucun déploiement pour l'instant.",
  "empty.operations": "Aucune opération ne correspond.",

  "field.panel": "Panneau",
  "field.key": "Clé",
  "field.user": "Compte",
  "field.reach": "Portée",
  "field.type": "Type",
  "field.source": "Source",
  "field.address": "Adresse",
  "field.lastDeploy": "Dernier déploiement",
  "field.recent": "Déploiements récents",
  "field.inProgress": "En cours",
  "field.created": "Créé",
  "field.started": "Début",
  "field.finished": "Fin",
  "field.by": "Par",
  "field.error": "Erreur",
  "field.output": "Sortie",
  "whoami.keyLine": "{name}, {level}, expire le {expires}",
  "whoami.keyLineNever": "{name}, {level}, sans expiration",
  "whoami.session": "une session de navigateur",
  "whoami.everyProject": "tous les projets",
  "whoami.noProject": "aucun projet pour l'instant",

  "deploy.queued": "{target} : déploiement en file, action {action} ({status}).",
  "restart.queued": "{target} : redémarrage en file, action {action} ({status}).",
  "start.queued": "{target} : démarrage en file, action {action} ({status}).",
  "stop.queued": "{target} : arrêt en file, action {action} ({status}).",
  "destroy.queued": "{target} : suppression en file, action {action} ({status}).",
  "deleteProject.queued": "{project} : suppression en file, action {action} ({status}).",
  "action.cancelled": "Action {action} : {status}.",
  "next.check": "Pour suivre : opsifier action {action}",

  "error.prefix": "Erreur",
  "error.hint": "Conseil",
  "warn.plainHttp":
    "Attention : OPSIFIER_URL est en HTTP simple, la clé API peut donc être lue en route vers {host}.",
  "warn.pollFailed": "Impossible de lire les nouvelles lignes ({reason}). Nouvel essai.",

  "usage.unknownCommand": "Commande inconnue : « {name} ».",
  "usage.keyFlag": "Les clés API ne sont lues que dans OPSIFIER_API_KEY, jamais dans un argument.",
  "usage.target":
    "Indiquez le service sous la forme projet/service, par exemple shop/web, et non « {value} ».",
  "usage.missingArgument": "Argument manquant : {name}.",
  "usage.extraArgument": "Argument inattendu : « {value} ».",
  "usage.duration": "Durée invalide : « {value} ». Utilisez par exemple 45s, 15m, 2h ou 1d.",
  "usage.limit": "Nombre entier positif attendu : « {value} ».",
  "usage.query": "Un paramètre de requête s'écrit nom=valeur, et non « {value} ».",
  "usage.json": "JSON invalide : {reason}",
  "usage.dataFile": "Impossible de lire « {file} » : {reason}",
  "confirm.stop": "Cela met {target} hors ligne. Relancez avec --yes pour confirmer.",
  "confirm.destroy":
    "Cela supprime {target} et tout ce qu'il exécute. Relancez avec --confirm {name} pour confirmer.",
  "confirm.project": "Cela supprime le projet {name}. Relancez avec --confirm {name} pour confirmer.",
  "confirm.api":
    "Cette opération est irréversible ou met quelque chose hors ligne. Relancez avec --yes pour confirmer.",

  "help.setup": "Préparer un dossier",
  "help.env.service": "le service visé quand une commande n'en nomme aucun, sous la forme projet/service",
  "help.target":
    "Une commande qui agit sur un service le prend sous la forme projet/service. Sinon, elle prend OPSIFIER_SERVICE, puis le dossier lié par opsifier link.",

  "cmd.link": "Lier ce dossier à un service : les commandes lancées ici agissent sur lui",
  "cmd.unlink": "Retirer le lien de ce dossier",
  "cmd.releases": "Lister les versions qu'un service conserve, celle qui tourne signalée",
  "cmd.rollback": "Relancer une version précédente, depuis l'image conservée sur le serveur",
  "cmd.config": "Lister les variables d'un service, ou en lire, définir et retirer",
  "cmd.open": "Afficher l'adresse d'un service, en lien que le terminal sait ouvrir",

  "flag.wait": "Attendre la fin en affichant la sortie, et échouer si cela échoue",
  "flag.deploy": "Déployer le service une fois les variables enregistrées",
  "flag.envProject":
    "Les variables qu'un projet partage avec tous ses services, au lieu de celles d'un service",
  "flag.confirmRollback": "Le nom exact du service, pour confirmer le retour en arrière",

  "col.version": "VERSION",
  "col.image": "IMAGE",
  "col.commit": "COMMIT",
  "col.by": "PAR",
  "col.created": "CRÉÉE",
  "col.note": "NOTE",

  "empty.releases": "Aucune version conservée pour l'instant : déployez d'abord le service.",
  "empty.releasesUnavailable":
    "Ce service ne conserve pas de versions : ni les bases de données, ni les stacks Compose, ni un service pas redéployé depuis l'arrivée des versions.",
  "empty.config": "{target} n'a aucune variable.",

  "release.running": "en marche",
  "release.rollbackOf": "retour à v{version}",
  "refusal.active": "en marche",
  "refusal.not_deployed": "n'a jamais tourné",
  "refusal.renamed": "service renommé depuis",
  "refusal.image_missing": "image absente du serveur",
  "refusal.image_altered": "image modifiée depuis",
  "refusal.volumes_differ": "volumes différents depuis",

  "link.done": "Ce dossier agit désormais sur {service}, sur {panel}. Le lien est dans {file}.",
  "unlink.done": "{file} supprimé.",
  "unlink.none": "Ce dossier n'a pas de lien ({file}).",

  "rollback.queued": "{target} : retour à v{version} en file, action {action} ({status}).",
  "rollback.none":
    "{target} ne conserve aucune version précédente qui puisse tourner de nouveau. Voir opsifier releases.",
  "rollback.unknown": "Aucune version v{version} n'est conservée. Voir opsifier releases.",
  "rollback.chooseVersion":
    "Le panneau ne peut pas dire quelle version de {target} tourne. Indiquez celle à relancer : opsifier releases les liste.",

  "config.hidden": "Les valeurs restent masquées : opsifier config get NOM --yes en affiche une.",
  "config.saved": "{target} : mis à jour : {names}.",
  "config.removed": "{target} : retiré : {names}.",
  "config.unchanged": "{target} : rien à changer.",
  "config.wasNotSet": "{target} : non défini : {names}.",
  "config.notFound": "{target} : variable introuvable : {names}.",
  "config.applyHint": "Cela s'applique au prochain déploiement : opsifier deploy {target}",
  "config.applyHintProject": "Cela s'applique au prochain déploiement de chaque service de {project}.",

  "open.none": "{target} n'a pas encore d'adresse : donnez-lui d'abord un domaine.",

  "wait.following": "{title} sur {target}, action {action} :",
  "wait.succeeded": "{title} sur {target} : réussi en {duration}.",
  "wait.failed":
    "{title} sur {target} n'a pas abouti ({status}) : {reason}. Détails : opsifier action {action}",
  "wait.detached": "Attente interrompue. L'action continue sur le panneau : opsifier action {action}",

  "usage.targetFrom":
    "Le service indiqué dans {source} est « {value} », qui n'est pas de la forme projet/service.",
  "usage.noTarget":
    "Indiquez le service sous la forme projet/service, renseignez OPSIFIER_SERVICE, ou liez ce dossier avec opsifier link projet/service.",
  "usage.linkPanel":
    "{file} lie ce dossier à {service} sur {panel}, mais cette commande s'adresse à {current}. Connectez-vous à {panel}, renseignez OPSIFIER_URL avec son adresse, ou liez le dossier de nouveau.",
  "usage.version":
    "Version invalide : « {value} ». Utilisez le numéro que donne opsifier releases, comme 4 ou v4.",
  "usage.envName":
    "Nom de variable invalide : « {value} ». Lettres, chiffres, _ . et -, sans chiffre au début.",
  "usage.envPair": "Écrivez chaque variable sous la forme NOM=valeur, et non « {value} ».",
  "usage.envNewline": "{name} : une valeur ne peut pas contenir de saut de ligne.",
  "usage.projectAndService": "Indiquez un service ou --project, pas les deux.",
  "usage.deployProject": "--deploy va avec les variables d'un service, pas avec --project.",
  "usage.waitWithoutDeploy": "Ici, --wait va avec --deploy.",

  "confirm.rollback":
    "Cela fait tourner v{version} ({image}) sur {target} à la place de la version actuelle. Relancez avec --confirm {name} pour confirmer.",
  "confirm.reveal":
    "Cela affiche des valeurs secrètes de {target}, et le panneau l'enregistre. Relancez avec --yes pour confirmer.",
  "confirm.unset": "Cela retire {names} de {target}. Relancez avec --yes pour confirmer.",

  "help.login":
    "Ou connectez-vous une fois : opsifier login https://panel.example.com garde la clé dans votre dossier de configuration.",
  "cmd.login":
    "Garder une clé API pour un panneau, pour que les commandes se passent de variables d'environnement",
  "cmd.logout": "Oublier la clé gardée pour un panneau",
  "cmd.create": "Créer un projet, ou un service dans un projet, avec sa source",
  "cmd.push": "Envoyer le code de ce dossier à un service et le déployer",

  "flag.image": "Faire tourner cette image, par exemple nginx:1.27",
  "flag.git": "Construire depuis ce dépôt Git",
  "flag.ref": "La branche, l'étiquette ou le commit à construire. main par défaut",
  "flag.gitPath": "Le dossier à construire, dans le dépôt. / par défaut",
  "flag.dockerfile": "Construire depuis ce Dockerfile, lu sur cette machine",
  "flag.database": "Une base de données plutôt qu'une application : postgres, mysql, mariadb, mongo ou redis",
  "flag.link": "Lier ce dossier au nouveau service",
  "flag.deployCreated": "Déployer aussitôt le nouveau service",
  "flag.dir": "Le dossier à envoyer. Par défaut, le dossier lié, ou celui-ci",
  "flag.uploadPath": "Le dossier à construire, dans ce qui est envoyé. / par défaut",
  "flag.uploadOnly": "Envoyer le code sans le déployer",

  "auth.keyWithoutUrl":
    "OPSIFIER_API_KEY est renseignée mais pas OPSIFIER_URL. Renseignez les deux, ou aucune et connectez-vous avec opsifier login.",
  "auth.none":
    "Aucun panneau à joindre : OPSIFIER_URL n'est pas renseignée, et opsifier login n'a gardé aucune clé.",
  "auth.noKeyFor":
    "Aucune clé API pour {panel} : OPSIFIER_API_KEY n'est pas renseignée, et opsifier login n'en a gardé aucune pour lui.",
  "hint.notConfigured":
    "Connectez-vous une fois avec opsifier login https://panel.example.com, ou renseignez OPSIFIER_URL et OPSIFIER_API_KEY.",
  "warn.credentialsExposed":
    "Attention : d'autres utilisateurs de cette machine peuvent lire {file}. Réservez-le à vous seul : chmod 600 {file}",

  "login.prompt": "Clé API pour {panel} (Réglages, Clés API) : ",
  "login.done":
    "Connecté à {panel} en tant que {user}. Les commandes s'adressent à ce panneau, sauf si OPSIFIER_URL en indique un autre.",
  "login.kept": "La clé est gardée dans {file}, lisible par vous seul.",
  "logout.nowhere": "Aucun panneau n'est connecté.",
  "logout.none": "Aucune clé n'est gardée pour {panel}.",
  "logout.done": "Clé de {panel} oubliée.",
  "logout.revoke":
    "La clé elle-même reste valable jusqu'à sa révocation dans le panneau, sous Réglages, Clés API.",

  "usage.loginAddress": "Indiquez l'adresse du panneau : opsifier login https://panel.example.com",
  "usage.loginKey": "Aucune clé API n'a été donnée.",
  "usage.projectOnly":
    "{project} est un projet : une source, --link et --deploy vont avec un service, sous la forme {project}/<service>.",
  "usage.oneSource": "Indiquez une seule source : --image, --git, --dockerfile ou --database.",
  "usage.refWithoutGit": "--ref et --path vont avec --git.",
  "usage.engine": "Moteur de base de données inconnu : « {value} ». Utilisez {engines}.",
  "usage.deployWithoutSource":
    "--deploy demande une source : --image, --git, --dockerfile ou --database. Sans source, envoyez le code avec opsifier push.",
  "usage.notAFolder": "{folder} n'est pas un dossier.",

  "create.project": "Projet {project} créé.",
  "create.service": "{target} créé.",
  "create.database": "{target} créé, une base de données {engine}. Le panneau a généré ses identifiants.",
  "create.linked": "Ce dossier est lié à {target}.",
  "create.nextPush": "Ensuite : opsifier push {target} envoie le code d'un dossier et le déploie.",
  "create.nextDeploy": "Ensuite : opsifier deploy {target} --wait",

  "confirm.pushReplaces":
    "{target} se déploie depuis {source}. Envoyer ce dossier remplace cette source. Relancez avec --yes pour confirmer.",

  "push.empty": "Rien à envoyer depuis {folder} : tous les fichiers sont ignorés, ou il n'y en a aucun.",
  "push.tooLarge":
    "L'archive fait {size}, plus que les {max} acceptés par le panneau. Écartez davantage de fichiers avec .opsifierignore.",
  "push.skipped": "Laissés de côté, car le panneau les refuserait : {paths}",
  "push.packed": "{files} fichiers de {folder} empaquetés ({size}, {compressed} compressés).",
  "push.uploaded": "Envoyé à {target}.",
  "push.nextDeploy": "Pour le déployer : opsifier deploy {target} --wait",

  "cmd.ps": "Afficher l'état d'un service et ce qu'il consomme : processeur, mémoire, réseau",
  "cmd.domains": "Lister les domaines d'un service, ou en ajouter, en retirer et choisir le principal",
  "cmd.maintenance": "Afficher, activer ou désactiver la page de maintenance d'un service",
  "cmd.db": "Afficher les identifiants d'une base de données, ou son adresse ou son mot de passe",
  "cmd.scripts": "Lister les scripts d'un service, ou en ajouter et en retirer",
  "cmd.run": "Lancer un script enregistré dans le conteneur du service, et afficher sa sortie",
  "cmd.backups": "Lister les sauvegardes d'un service, ou en faire une tout de suite",

  "flag.port": "Le port qu'écoute le service dans son conteneur. 80 par défaut",
  "flag.domainPath": "Seulement ce chemin du domaine, comme /api",
  "flag.primary": "En faire l'adresse principale du service",
  "flag.http": "HTTP simple uniquement, sans certificat",
  "flag.title": "Le titre de la page de maintenance",
  "flag.subtitle": "La ligne sous le titre",
  "flag.external": "L'adresse depuis l'extérieur du serveur, au lieu de celle dans le projet",
  "flag.root": "Le mot de passe de l'administrateur, au lieu de celui de l'utilisateur de l'application",
  "flag.command": "Le script lui-même, lancé avec sh dans le conteneur du service",
  "flag.file": "Un fichier de cette machine qui contient le script",
  "flag.cron": 'Le lancer selon cette planification, comme "0 3 * * *"',
  "flag.tz": "Le fuseau horaire de la planification, comme Europe/Paris. UTC par défaut",
  "flag.afterDeploy": "Le lancer après chaque déploiement réussi",
  "flag.detach": "Le lancer et rendre la main, sans attendre sa sortie",

  "col.address": "ADRESSE",
  "col.port": "PORT",
  "col.primary": "PRINCIPAL",
  "col.name": "NOM",
  "col.schedule": "PLANIFICATION",
  "col.afterDeploy": "APRÈS DÉPLOIEMENT",
  "col.lastRun": "DERNIÈRE EXÉCUTION",
  "col.what": "QUOI",
  "col.size": "TAILLE",
  "col.where": "OÙ",

  "empty.domains": "Aucun domaine pour l'instant : opsifier domains add <hôte> en donne un au service.",
  "empty.scripts":
    "Aucun script pour l'instant : opsifier scripts add <nom> --command <script> en enregistre un.",
  "empty.backups": "Aucune sauvegarde pour l'instant.",

  "field.engine": "Moteur",
  "field.dbUser": "Utilisateur",
  "field.dbName": "Base",
  "field.inside": "Dans le projet",
  "field.outside": "Depuis l'extérieur",
  "field.url": "Adresse",
  "field.warning": "Attention",
  "field.cpu": "Processeur",
  "field.memory": "Mémoire",
  "field.network": "Réseau",
  "field.readAt": "Relevé à",

  "domains.unknown": "Aucun domaine {host} sur ce service. Voir opsifier domains.",
  "domains.primaryMark": "oui",
  "domains.added": "{target} répond désormais à {url}.",
  "domains.addedPrimary": "{target} répond désormais à {url}, son adresse principale.",
  "domains.dns":
    "Faites pointer {host} vers ce serveur dans son DNS : le certificat vient dès qu'il y répond.",
  "domains.removed": "{url} retiré.",
  "domains.madePrimary": "{url} est désormais l'adresse principale de {target}.",

  "maintenance.isOn": "{target} : page de maintenance active ({title}).",
  "maintenance.isOff": "{target} : page de maintenance inactive.",
  "maintenance.turnedOn": "{target} : page de maintenance active. Le service lui-même continue de tourner.",
  "maintenance.turnedOff": "{target} : page de maintenance retirée, le service répond de nouveau.",

  "db.rotationUnresolved": "un changement de mot de passe n'a pas abouti : voir le service dans le panneau",
  "db.notExposed": "pas joignable depuis l'extérieur",

  "scripts.yes": "oui",
  "scripts.added": "Script {name} enregistré sur {target}.",
  "scripts.runHint": "Pour le lancer : opsifier run {name}",
  "scripts.unknown": "{target} n'a pas de script {name}. Voir opsifier scripts.",
  "scripts.removed": "Script {name} retiré de {target}.",

  "run.queued": "{target} : script {name} en file, action {action} ({status}).",
  "run.detached": "Attente interrompue. Le script continue : opsifier action {action}",
  "run.succeeded": "{name} : terminé en {duration}.",
  "run.failed": "{name} n'a pas abouti ({status}, code de sortie {code}) : {reason}",

  "backups.config": "Réglage {id} : {what}, {schedule}, vers {where}, prochaine {next}",
  "backups.unknown": "{target} n'a pas de réglage de sauvegarde {id}. Voir opsifier backups.",
  "backups.none":
    "{target} n'a encore aucun réglage de sauvegarde : créez-en un dans le panneau, sous Sauvegardes.",
  "backups.queued": "{target} : sauvegarde en file, action {action} ({status}).",

  "ps.noReadings": "Aucun relevé pour l'instant : ils viennent dès que le service tourne.",
  "ps.memoryOf": "{used} sur {limit}",
  "ps.network": "entrée {rx}, sortie {tx}",

  "usage.port": "Port invalide : « {value} ». Utilisez un nombre de 1 à 65535.",
  "usage.host":
    "Indiquez un hôte comme example.com, ou une adresse complète comme https://example.com/api, et non « {value} ».",
  "usage.domainPath": "{host} a plusieurs chemins ({paths}) : indiquez-en un avec --path.",
  "usage.scriptBody": "Donnez le script avec --command, ou un fichier qui le contient avec --file.",
  "usage.tzWithoutCron": "--tz va avec --cron.",
  "usage.backupConfig": "Ce service a plusieurs réglages de sauvegarde : indiquez l'un de {ids}.",

  "confirm.removeDomain": "Cela retire {url} de {target}. Relancez avec --yes pour confirmer.",
  "confirm.maintenance":
    "Cela affiche la page de maintenance à la place de {target} pour tous les visiteurs. Relancez avec --yes pour confirmer.",
  "confirm.revealSecret":
    "Cela affiche un secret de {target}, et le panneau l'enregistre. Relancez avec --yes pour confirmer.",
  "confirm.removeScript": "Cela retire le script {name} de {target}. Relancez avec --yes pour confirmer.",

  "cmd.completion": "Afficher le script de complétion d'un shell : bash, zsh ou fish",
  "cmd.__targets": "Lister chaque service sous la forme projet/service, un par ligne, pour la complétion",
  "usage.shell": "Pas de complétion pour « {value} » : utilisez bash, zsh ou fish.",

  "flag.includeSecrets": "Envoyer aussi les fichiers dont le nom évoque des secrets, comme .env",
  "push.interrupted": "Interrompu : rien de plus n'a été envoyé, et aucun déploiement n'a été lancé.",
  "push.notAProject":
    "{folder} n'est pas le dossier d'un projet : un dossier personnel, la racine et les dossiers au-dessus des clés de cette ligne de commande ne sont jamais envoyés. Lancez-la depuis le projet, ou liez le dossier du projet.",
  "push.secretsRefused":
    "Ces fichiers contiennent peut-être des secrets : {paths}. Écartez-les dans .gitignore ou .opsifierignore, ou relancez avec --include-secrets pour les envoyer.",
  "push.secretsIncluded": "Envoi de fichiers qui contiennent peut-être des secrets, comme demandé : {paths}",
  "usage.waitWithUploadOnly": "--wait suit le déploiement, que --upload-only écarte.",
  "usage.loginExtra":
    "opsifier login ne prend que l'adresse du panneau. La clé est demandée, jamais donnée en argument.",
  "usage.loginAddressInvalid":
    "Ce n'est pas l'adresse d'un panneau. Indiquez-en une comme https://panel.example.com.",
  "login.reused":
    "Connecté à {panel} en tant que {user}, avec la clé déjà gardée pour lui. Les commandes s'adressent à ce panneau, sauf si OPSIFIER_URL en indique un autre.",
  "logout.choose":
    "Aucun panneau n'est sélectionné désormais. Des clés restent gardées pour {panels} : opsifier login <adresse> en reprend une.",
  "wait.gaveUp":
    "Le panneau ne répond plus depuis cinq minutes. Le travail continue peut-être : opsifier action {action}",
  "scripts.changed":
    "La liste des scripts a changé pendant le retrait de {name}. Vérifiez-la avec opsifier scripts.",
};

const CATALOGUES: Record<Locale, Record<MessageKey, string>> = { en, fr };

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function translator(locale: Locale): Translate {
  const messages = CATALOGUES[locale];
  return (key, params = {}) =>
    messages[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => String(params[name] ?? placeholder));
}

/** The language people set for their whole environment, in the order the system itself reads them. */
export function localeFrom(env: Record<string, string | undefined>): Locale {
  const setting = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return setting.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export { en as englishMessages, fr as frenchMessages };
