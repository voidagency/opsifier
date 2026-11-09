import { createHash } from "node:crypto";
import {
  BOX_BASE_IMAGE,
  BOX_RUN_AS,
  BOX_WORKSPACE_PATH,
  type BoxModuleChoice,
  type BoxModuleId,
  boxModule,
} from "@opsifier/contract";
import type { StoredBox } from "./spec";
import {
  BOX_CONTROL_PATH,
  BOX_CONTROL_SCRIPT,
  BOX_INSTALL_DIR,
  BOX_START_GRACE_SECONDS,
  BOX_SUPERVISOR_SCRIPT,
} from "./supervisor";

const RUN_DIR = "/run/opsifier";
const NGINX_CONFIG = `${BOX_INSTALL_DIR}/nginx.conf`;
const PHP_FPM_CONFIG = `${BOX_INSTALL_DIR}/php-fpm.conf`;
const PHP_SOCKET = `${RUN_DIR}/php-fpm.sock`;

/** What every box starts from. One layer, so a hundred boxes on a server hold one copy of it. */
const BASE_PACKAGES = ["bash", "ca-certificates", "curl", "git", "openssh-client", "tzdata"];

/** Enough of PHP that most code runs. Anything further is chosen on the module's own line. */
const PHP_CORE_PACKAGES = [
  "fpm",
  "phar",
  "mbstring",
  "openssl",
  "curl",
  "iconv",
  "tokenizer",
  "session",
  "ctype",
  "dom",
  "fileinfo",
  "xml",
];

/** The package an extension comes from, and the name PHP knows it by once loaded. */
const PHP_EXTENSION_PACKAGES: Readonly<Record<string, { package: string; loads: string }>> = {
  opcache: { package: "opcache", loads: "Zend OPcache" },
  gd: { package: "gd", loads: "gd" },
  intl: { package: "intl", loads: "intl" },
  zip: { package: "zip", loads: "zip" },
  bcmath: { package: "bcmath", loads: "bcmath" },
  exif: { package: "exif", loads: "exif" },
  mysqli: { package: "mysqli", loads: "mysqli" },
  pdo_mysql: { package: "pdo_mysql", loads: "pdo_mysql" },
  pdo_pgsql: { package: "pdo_pgsql", loads: "pdo_pgsql" },
  pdo_sqlite: { package: "pdo_sqlite", loads: "pdo_sqlite" },
  redis: { package: "pecl-redis", loads: "redis" },
  imagick: { package: "pecl-imagick", loads: "imagick" },
};

const COMPOSER = {
  url: "https://getcomposer.org/download/2.11.1/composer.phar",
  sha256: "6f1b891e1d4927d62740276c540fb490e47689e19e102c49e8da849794882f8c",
};

/** The versions of the package managers Node.js can be given. */
const NODE_TOOLS: Readonly<Record<string, string>> = { pnpm: "12.18.0", yarn: "1.22.22" };

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Pinned to one image, the module's version and the matrix's edition of it. */
function pinOf(id: BoxModuleId, version: string): string {
  const pin = boxModule(id).versions.find((candidate) => candidate.version === version)?.pin;
  if (pin === undefined) {
    throw new Error(`The matrix has no ${id} ${version}.`);
  }
  return pin;
}

/** A here-document's marker that its own content can't contain, derived from that content. */
function heredocMarker(content: string): string {
  return `OPSIFIER_EOF_${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

/** A file written into the image. Nothing in it is interpreted: a quoted marker turns expansion off. */
function fileStep(path: string, content: string, mode = "0644"): string[] {
  const marker = heredocMarker(content);
  return [
    `COPY --chmod=${mode} <<'${marker}' ${path}`,
    content.endsWith("\n") ? content.slice(0, -1) : content,
    marker,
    "",
  ];
}

function runStep(...commands: string[]): string[] {
  return [`RUN ${commands.join(" \\\n  && ")}`, ""];
}

/** Copied whole from the runtime's own image, so a box gets exactly the version the matrix names. */
function copyRuntime(pin: string, paths: readonly string[]): string[] {
  return [...paths.map((path) => `COPY --link --from=${pin} ${path} ${path}`), ""];
}

function phpSteps(choice: BoxModuleChoice): string[] {
  const [pinName = ""] = pinOf("php", choice.version).split(" ");
  const packages = choice.extensions.flatMap((name) => {
    const known = PHP_EXTENSION_PACKAGES[name];
    return known === undefined ? [] : [known.package];
  });
  const installs = [...PHP_CORE_PACKAGES, ...packages].map((name) => `${pinName}-${name}`);
  const loaded = choice.extensions.flatMap((name) => {
    const known = PHP_EXTENSION_PACKAGES[name];
    return known === undefined ? [] : [known.loads];
  });
  const commands = [
    `apk add --no-cache ${pinName} ${installs.join(" ")}`,
    `ln -sf /usr/bin/${pinName} /usr/local/bin/php`,
    `ln -sf /usr/sbin/php-fpm${pinName.slice(3)} /usr/local/bin/php-fpm`,
    "php --version",
    ...(loaded.length > 0 ? [phpLoadsCheck(loaded)] : []),
    ...(choice.extensions.includes("composer")
      ? [
          `curl -fsSL -o /usr/local/bin/composer ${COMPOSER.url}`,
          `echo "${COMPOSER.sha256}  /usr/local/bin/composer" | sha256sum -c -`,
          "chmod 755 /usr/local/bin/composer",
        ]
      : []),
  ];
  return runStep(...commands);
}

/** Fails the build, and so the deployment, when an extension installs but does not load. */
function phpLoadsCheck(extensions: readonly string[]): string {
  const list = extensions.map((name) => `"${name}"`).join(", ");
  return `php -r 'foreach ([${list}] as $e) { if (!extension_loaded($e)) { fwrite(STDERR, "PHP did not load $e\\n"); exit(1); } }'`;
}

const nodeCopies = (choice: BoxModuleChoice): string[] =>
  copyRuntime(pinOf("node", choice.version), ["/usr/local/bin/", "/usr/local/lib/node_modules/"]);

/** Package managers, added globally once Node.js itself can run. */
function nodeToolSteps(choice: BoxModuleChoice): string[] {
  const tools = choice.extensions.flatMap((name) => {
    const version = NODE_TOOLS[name];
    return version === undefined ? [] : [`${name}@${version}`];
  });
  return tools.length === 0
    ? []
    : runStep(
        `npm install --global ${tools.join(" ")}`,
        ...choice.extensions.map((name) => `${name} --version`),
      );
}

/** Whatever shared libraries the copied runtimes need, resolved the way those images resolve them. */
function sharedLibrariesStep(): string[] {
  return runStep(
    "apk add --no-cache --virtual .opsifier-scan scanelf",
    `scanelf --recursive --needed --nobanner --format '%n#p' /usr/local/bin /usr/local/lib | tr ',' '\\n' | sort -u | awk 'system("[ -e /usr/local/lib/" $1 " ]") == 0 { next } { print "so:" $1 }' | xargs -r apk add --no-cache`,
    "apk del --no-network .opsifier-scan",
  );
}

/** Fails the build when a runtime landed but can't run, instead of at the first request. */
function smokeTests(box: StoredBox): string[] {
  const { node, python, ruby } = box.modules;
  return [
    ...(node === null ? [] : ["node --version", "npm --version"]),
    ...(python === null
      ? []
      : ["python3 --version", `python3 -c "import ssl, sqlite3, zlib, hashlib, json"`, "pip --version"]),
    ...(ruby === null ? [] : ["ruby --version", "gem --version"]),
  ];
}

function nginxConfig(documentRoot: string, withPhp: boolean): string {
  const root = documentRoot === "." ? BOX_WORKSPACE_PATH : `${BOX_WORKSPACE_PATH}/${documentRoot}`;
  const php = withPhp
    ? `
    location ~ \\.php$ {
      include fastcgi.conf;
      fastcgi_pass unix:${PHP_SOCKET};
    }`
    : "";
  return `worker_processes auto;
pid ${RUN_DIR}/nginx.pid;
error_log /dev/stderr warn;

events {
  worker_connections 1024;
}

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log /dev/stdout;
  sendfile on;
  client_body_temp_path ${RUN_DIR}/nginx/body;
  proxy_temp_path ${RUN_DIR}/nginx/proxy;
  fastcgi_temp_path ${RUN_DIR}/nginx/fastcgi;
  uwsgi_temp_path ${RUN_DIR}/nginx/uwsgi;
  scgi_temp_path ${RUN_DIR}/nginx/scgi;

  server {
    listen __PORT__;
    root ${root};
    index index.php index.html;

    location / {
      try_files $uri $uri/ ${withPhp ? "/index.php?$query_string" : "=404"};
    }${php}
  }
}
`;
}

const PHP_FPM_FILE = `[global]
daemonize = no
error_log = /proc/self/fd/2

[www]
listen = ${PHP_SOCKET}
clear_env = no
catch_workers_output = yes
decorate_workers_output = no
pm = dynamic
pm.max_children = 8
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 4
`;

const processScript = (directory: string, command: string): string =>
  `#!/bin/sh\ncd ${shellQuote(directory)} || exit 127\n${command}\n`;

const hookScript = (text: string): string => `#!/bin/sh\nset -e\n${text.endsWith("\n") ? text : `${text}\n`}`;

function configSteps(box: StoredBox): string[] {
  const { nginx, php } = box.modules;
  const steps: string[] = [
    ...fileStep(`${BOX_INSTALL_DIR}/supervise`, BOX_SUPERVISOR_SCRIPT, "0755"),
    ...fileStep(BOX_CONTROL_PATH, BOX_CONTROL_SCRIPT, "0755"),
  ];
  if (nginx !== null) {
    steps.push(...fileStep(NGINX_CONFIG, nginxConfig(nginx.documentRoot, php !== null)));
    steps.push(
      ...fileStep(
        `${BOX_INSTALL_DIR}/processes/nginx`,
        `#!/bin/sh\nsed "s/__PORT__/\${PORT:-80}/" ${NGINX_CONFIG} >${RUN_DIR}/nginx.conf\nexec nginx -e stderr -c ${RUN_DIR}/nginx.conf -g 'daemon off;'\n`,
        "0755",
      ),
    );
    if (php !== null) {
      steps.push(...fileStep(PHP_FPM_CONFIG, PHP_FPM_FILE));
      steps.push(
        ...fileStep(
          `${BOX_INSTALL_DIR}/processes/php-fpm`,
          `#!/bin/sh\nexec php-fpm --nodaemonize --force-stderr --fpm-config ${PHP_FPM_CONFIG}\n`,
          "0755",
        ),
      );
    }
  }
  for (const process of box.processes) {
    if (process.enabled) {
      steps.push(
        ...fileStep(
          `${BOX_INSTALL_DIR}/processes/${process.name}`,
          processScript(process.directory, process.command),
          "0755",
        ),
      );
    }
  }
  if (box.hooks.start.trim() !== "") {
    steps.push(...fileStep(`${BOX_INSTALL_DIR}/hooks/start`, hookScript(box.hooks.start), "0755"));
  }
  return steps;
}

/**
 * The image a box's settings describe, as a Dockerfile. Pure, so it can be tested without Docker, and
 * ordered to reuse layers: what every box shares first, the runtimes next, and last what changes most,
 * so changing a process or a hook only rewrites the top of the image.
 */
export function renderBoxDockerfile(box: StoredBox): string {
  const { php, nginx, node, python, ruby } = box.modules;
  const { uid, gid, user } = BOX_RUN_AS;
  const copiedRuntime = node !== null || python !== null || ruby !== null;
  const tests = smokeTests(box);
  const dockerfile: string[] = [
    "# Generated by Opsifier from this box's modules, processes and hooks. Change those, not this.",
    `FROM ${BOX_BASE_IMAGE}`,
    "",
    ...runStep(
      `apk add --no-cache ${BASE_PACKAGES.join(" ")}`,
      `addgroup -g ${gid} ${user}`,
      `adduser -D -u ${uid} -G ${user} -h /home/${user} -s /bin/bash ${user}`,
      `install -d -o ${uid} -g ${gid} ${BOX_WORKSPACE_PATH} ${RUN_DIR} ${RUN_DIR}/state ${RUN_DIR}/nginx`,
    ),
    ...(php === null ? [] : phpSteps(php)),
    ...(nginx === null ? [] : runStep("apk add --no-cache nginx", "nginx -v")),
    ...(node === null ? [] : nodeCopies(node)),
    ...(python === null
      ? []
      : copyRuntime(pinOf("python", python.version), ["/usr/local/bin/", "/usr/local/lib/"])),
    ...(ruby === null
      ? []
      : copyRuntime(pinOf("ruby", ruby.version), [
          "/usr/local/bin/",
          "/usr/local/lib/",
          "/usr/local/bundle/",
          "/usr/local/etc/",
        ])),
    ...(copiedRuntime ? sharedLibrariesStep() : []),
    ...(node === null ? [] : nodeToolSteps(node)),
    ...(tests.length > 0 ? runStep(...tests) : []),
  ];

  if (box.hooks.build.trim() !== "") {
    dockerfile.push(
      ...fileStep(`${BOX_INSTALL_DIR}/hooks/build`, hookScript(box.hooks.build), "0755"),
      ...runStep(`${BOX_INSTALL_DIR}/hooks/build`),
    );
  }

  dockerfile.push(...configSteps(box));
  dockerfile.push(
    `ENV HOME=/home/${user}${ruby === null ? "" : ` BUNDLE_PATH=${BOX_WORKSPACE_PATH}/vendor/bundle`}`,
    `USER ${uid}:${gid}`,
    `WORKDIR ${BOX_WORKSPACE_PATH}`,
    `HEALTHCHECK --interval=5s --timeout=3s --retries=3 --start-period=${BOX_START_GRACE_SECONDS}s CMD ["${BOX_CONTROL_PATH}", "ready"]`,
    `ENTRYPOINT ["${BOX_INSTALL_DIR}/supervise"]`,
    "",
  );
  return dockerfile.join("\n");
}
