// The demo page's simulated panel. Everything happens in this tab: no request leaves the page, and
// every service, number and log line below is made up. The words come from demo-text.ts.
import { DEMO_TEXT, type DemoText } from "./demo-text";

type State = "failed" | "degraded" | "unknown" | "progress" | "running" | "stopped";
type Kind = "app" | "postgres" | "mysql" | "redis";
type Tab = "overview" | "deployments" | "logs" | "domains" | "environment" | "backups";
type Elsewhere = "monitor" | "domains" | "settings";

interface Version {
  n: number;
  image: string;
  at: number;
}
interface Domain {
  host: string;
  cert: "checking" | "requesting" | "issued";
  mine: boolean;
}
interface Backup {
  id: number;
  at: number;
  size: string;
  status: "running" | "done" | "restoring" | "restored";
}
interface LogLine {
  text: string;
  error: boolean;
}
interface Run {
  lines: string[];
  started: number;
  took: number | null;
}
interface Service {
  name: string;
  kind: Kind;
  image: string;
  state: State;
  versions: Version[];
  active: number;
  domains: Domain[];
  backups: Backup[];
  env: string;
  /** What is being typed in the environment, kept across repaints until it is saved. */
  envDraft: string | null;
  envSaved: boolean;
  logs: LogLine[];
  run: Run | null;
  mine: boolean;
}
interface Project {
  name: string;
  services: Service[];
}
type View =
  | { name: "overview" }
  | { name: "project"; project: string }
  | { name: "service"; project: string; service: string; tab: Tab }
  | { name: "activity" }
  | { name: "elsewhere"; what: Elsewhere };
interface Happening {
  at: number;
  text: string;
  state: State;
}
interface World {
  projects: Project[];
  view: View;
  events: Happening[];
  done: Set<number>;
  hint: string | null;
  filter: string;
  errorsOnly: boolean;
  paused: boolean;
  dialog: null | { kind: "service"; project: string; step: "kind" | "form"; choice: Kind; error: string } | { kind: "project"; error: string } | { kind: "site"; url: string; service: string; image: string; version: number };
  domainError: string;
  /** The domain being typed, kept across repaints. */
  draft: string;
  gauges: { cpu: number; mem: number; disk: number; net: number[] };
  nextBackup: number;
}

const STATES: State[] = ["failed", "degraded", "unknown", "progress", "running", "stopped"];
const IP = "203.0.113.10";
const DOCS: Record<Elsewhere, string> = { monitor: "/docs/", domains: "/docs/domains/", settings: "/docs/" };
const ICONS: Record<Kind | "project", string> = {
  app: '<rect x="3" y="4" width="18" height="16"/><path d="M3 10H21"/><path d="M6 7H10"/>',
  postgres:
    '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6V18C4 19.66 7.58 21 12 21S20 19.66 20 18V6"/><path d="M12 9V21M4 14.5H20"/>',
  mysql:
    '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6V18C4 19.66 7.58 21 12 21S20 19.66 20 18V6"/><path d="M4 12C4 13.66 7.58 15 12 15S20 13.66 20 12"/>',
  redis: '<path d="M12 3 21 7.5 12 12 3 7.5Z"/><path d="M3 12 12 16.5 21 12"/><path d="M3 16.5 12 21 21 16.5"/>',
  project: '<rect x="3" y="3" width="18" height="18"/><path d="M3 9H21M10 9V21"/>',
};

const now = () => Date.now() / 1000;
const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** A seeded generator, so the made-up numbers and lines look the same on every visit. */
function generator(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let m = Math.imul(s ^ (s >>> 15), 1 | s);
    m = (m + Math.imul(m ^ (m >>> 7), 61 | m)) ^ m;
    return ((m ^ (m >>> 14)) >>> 0) / 4294967296;
  };
}

function service(name: string, kind: Kind, image: string, state: State, ages: number[], extra: Partial<Service> = {}): Service {
  const t = now();
  // Given versions only name their images: their times come from the ages.
  const { versions: images, ...rest } = extra;
  const versions = ages.map((age, i) => ({ n: i + 1, image: images?.[i]?.image ?? image, at: t - age }));
  return {
    name,
    kind,
    image,
    state,
    versions,
    active: versions.length,
    domains: [],
    backups: [],
    env: kind === "app" ? "NODE_ENV=production\nPORT=80\n" : "",
    envDraft: null,
    envSaved: false,
    logs: [],
    run: null,
    mine: false,
    ...rest,
  };
}

function initialWorld(): World {
  const day = 86400;
  const web = service("web", "app", "ghcr.io/acme/storefront:2.4.0", "running", [3 * day, 2 * day, 3600], {
    versions: [
      { n: 1, image: "ghcr.io/acme/storefront:2.3.0", at: 0 },
      { n: 2, image: "ghcr.io/acme/storefront:2.3.1", at: 0 },
      { n: 3, image: "ghcr.io/acme/storefront:2.4.0", at: 0 },
    ],
  });
  web.domains = [
    { host: `shop-web.${IP}.sslip.io`, cert: "issued", mine: false },
    { host: "shop.example.com", cert: "issued", mine: false },
  ];
  const postgres = service("postgres", "postgres", "postgres:17", "running", [5 * day]);
  postgres.backups = [{ id: 1, at: now() - 11 * 3600, size: "18.4 MB", status: "done" }];
  return {
    projects: [
      {
        name: "shop",
        services: [
          web,
          service("worker", "app", "ghcr.io/acme/storefront-worker:2.4.0", "running", [3600]),
          postgres,
        ],
      },
      {
        name: "blog",
        services: [
          service("site", "app", "ghost:5-alpine", "running", [9 * day]),
          service("mysql", "mysql", "mysql:8.4", "running", [9 * day]),
        ],
      },
      { name: "tools", services: [service("whoami", "app", "traefik/whoami:v1.10", "stopped", [14 * day])] },
    ],
    view: { name: "overview" },
    events: [],
    done: new Set(),
    hint: null,
    filter: "",
    errorsOnly: false,
    paused: false,
    dialog: null,
    domainError: "",
    draft: "",
    gauges: { cpu: 23, mem: 41, disk: 32, net: [12, 18, 14, 22, 17, 25, 19, 16, 21, 27, 20, 15, 23, 26, 18, 22] },
    nextBackup: 2,
  };
}

export function startDemo(root: HTMLElement) {
  const locale = (root.dataset.locale === "fr" ? "fr" : "en") as "en" | "fr";
  const T: DemoText = DEMO_TEXT[locale];
  const version = root.dataset.version ?? "";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const main = root.querySelector<HTMLElement>("[data-dm-main]") as HTMLElement;
  const bar = root.querySelector<HTMLElement>("[data-dm-bar]") as HTMLElement;
  const dialog = root.querySelector<HTMLDialogElement>("[data-dm-dialog]") as HTMLDialogElement;
  const live = root.querySelector<HTMLElement>("[data-dm-live]") as HTMLElement;
  const random = generator(20261125);
  const timers = new Set<number>();
  let world = initialWorld();

  const later = (ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };
  const say = (text: string) => {
    live.textContent = "";
    later(60, () => {
      live.textContent = text;
    });
  };
  const project = (name: string) => world.projects.find((p) => p.name === name);
  const find = (p: string, s: string) => project(p)?.services.find((x) => x.name === s);
  const record = (text: string, state: State) => world.events.unshift({ at: now(), text, state });
  const lamp = (state: State, size = "s") =>
    `<svg class="lamp lamp--${size}" data-state="${state}" aria-hidden="true"><use href="#l-${state}"></use></svg>`;
  const icon = (kind: Kind | "project") =>
    `<svg class="dm-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${ICONS[kind]}</svg>`;
  const hostOf = (p: string, s: string) => `${p}-${s}.${IP}.sslip.io`;

  // ------------------------------------------------------------------ steps of the tour
  function complete(step: number) {
    if (world.done.has(step)) {
      return;
    }
    world.done.add(step);
    world.hint = null;
    paintSteps();
  }
  function paintSteps() {
    for (const el of root.querySelectorAll<HTMLElement>("li[data-step]")) {
      const n = Number(el.dataset.step);
      el.toggleAttribute("data-done", world.done.has(n));
    }
    const all = root.querySelector<HTMLElement>("[data-dm-all]");
    if (all) {
      all.hidden = world.done.size < 5;
    }
  }
  /** The app the tour talks about: the one the visitor deployed, or the shop's web. */
  function tourApp(): [string, Service] {
    for (const p of world.projects) {
      const mine = p.services.find((s) => s.mine && s.kind === "app" && s.state === "running");
      if (mine) {
        return [p.name, mine];
      }
    }
    return ["shop", find("shop", "web") as Service];
  }
  function show(step: number) {
    const [p, app] = tourApp();
    if (step === 0) {
      world.view = { name: "project", project: "shop" };
      world.hint = "new-service";
    } else if (step === 1) {
      world.view = { name: "service", project: p, service: app.name, tab: "overview" };
      world.hint = "tab-logs";
    } else if (step === 2) {
      world.view = { name: "service", project: p, service: app.name, tab: "domains" };
      world.hint = "domain-input";
    } else if (step === 3) {
      const target: [string, Service] = app.versions.length > 1 ? [p, app] : ["shop", find("shop", "web") as Service];
      world.view = { name: "service", project: target[0], service: target[1].name, tab: "deployments" };
      world.hint = "go-back";
    } else {
      world.view = { name: "service", project: "shop", service: "postgres", tab: "backups" };
      world.hint = "run-backup";
    }
    render();
    root.querySelector<HTMLElement>("[data-dm-window]")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
    root.querySelector<HTMLElement>(`[data-tour="${world.hint}"]`)?.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ runs: deployments, starts, stops
  function step(svc: Service, lines: Array<[number, string]>, end: () => void) {
    svc.run = { lines: [], started: now(), took: null };
    const run = svc.run;
    for (const [ms, text] of lines) {
      later(ms, () => {
        run.lines.push(text);
        refresh();
      });
    }
    const last = lines[lines.length - 1]?.[0] ?? 0;
    later(last + 50, () => {
      run.took = Math.max(1, Math.round(now() - run.started));
      end();
      refresh();
    });
  }
  function deploy(p: string, svc: Service, image = svc.image) {
    if (svc.state === "progress") {
      return;
    }
    const n = svc.versions.length + 1;
    const digest = Array.from({ length: 4 }, () => Math.floor(random() * 65536).toString(16).padStart(4, "0")).join("").slice(0, 12);
    const mb = 8 + Math.round(random() * 40);
    svc.state = "progress";
    say(T.states.progress);
    step(
      svc,
      [
        [0, T.run.started(n)],
        [500, T.run.pulling(image)],
        [1600, T.run.pulled(digest, mb)],
        [2400, T.run.starting],
        [3400, T.run.health],
        [4700, T.run.healthy],
        [5300, T.run.switching(n)],
        [5900, T.run.settled(6)],
      ],
      () => {
        svc.versions.push({ n, image, at: now() });
        svc.active = n;
        svc.image = image;
        svc.state = "running";
        if (svc.domains.length === 0) {
          svc.domains.push({ host: hostOf(p, svc.name), cert: "issued", mine: false });
        }
        record(T.events.deployed(p, svc.name, n), "running");
        say(T.announce.running(svc.name));
        if (svc.mine && svc.kind === "app") {
          complete(0);
        }
      },
    );
    refresh();
  }
  function goBack(p: string, svc: Service, n: number) {
    const target = svc.versions.find((v) => v.n === n);
    if (!target || svc.state === "progress") {
      return;
    }
    svc.state = "progress";
    say(T.states.progress);
    step(
      svc,
      [
        [0, T.run.goingBack(n, target.image)],
        [900, T.run.starting],
        [2000, T.run.health],
        [3000, T.run.healthy],
        [3500, T.run.switching(n)],
        [4000, T.run.settled(4)],
      ],
      () => {
        svc.active = n;
        svc.image = target.image;
        svc.state = "running";
        record(T.events.wentBack(p, svc.name, n), "running");
        say(T.announce.running(svc.name));
        complete(3);
      },
    );
    refresh();
  }
  function createDatabase(p: string, svc: Service) {
    svc.state = "progress";
    const engine = T.kinds[svc.kind];
    step(
      svc,
      [
        [0, T.run.database(engine)],
        [1200, T.run.volume],
        [2400, T.run.starting],
        [3600, T.run.accepting],
        [4200, T.run.settled(4)],
      ],
      () => {
        svc.state = "running";
        svc.versions.push({ n: 1, image: svc.image, at: now() });
        svc.active = 1;
        record(T.events.created(p, svc.name), "running");
        say(T.announce.running(svc.name));
      },
    );
  }
  function stopStart(p: string, svc: Service, to: "stopped" | "running") {
    if (svc.state === "progress") {
      return;
    }
    svc.state = "progress";
    const lines: Array<[number, string]> =
      to === "stopped"
        ? [
            [0, T.run.stopping],
            [1200, T.run.stopped],
          ]
        : [
            [0, T.run.starting],
            [1300, T.run.health],
            [2300, T.run.healthy],
            [2700, T.run.settled(3)],
          ];
    step(svc, lines, () => {
      svc.state = to;
      record(to === "stopped" ? T.events.stopped(p, svc.name) : T.events.started(p, svc.name), to);
      say(to === "stopped" ? T.announce.stopped(svc.name) : T.announce.running(svc.name));
    });
    refresh();
  }

  // ------------------------------------------------------------------ logs
  const PATHS = ["/", "/", "/products", "/products/roast-12", "/cart", "/api/stock", "/assets/app.css", "/assets/app.js", "/favicon.ico", "/about"];
  const BOTS = ["/wp-login.php", "/.env", "/phpmyadmin/", "/.git/config"];
  const AGENTS = ["Mozilla/5.0 (Macintosh)", "Mozilla/5.0 (iPhone)", "Mozilla/5.0 (Windows NT 10.0)", "curl/8.7"];
  function stamp() {
    const d = new Date();
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const two = (n: number) => String(n).padStart(2, "0");
    return `${two(d.getUTCDate())}/${months[d.getUTCMonth()]}/${d.getUTCFullYear()}:${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
  }
  function logLine(svc: Service): LogLine {
    const iso = new Date().toISOString().replace("T", " ").slice(0, 23);
    if (svc.kind === "app") {
      const bot = random() < 0.12;
      const path = bot ? BOTS[Math.floor(random() * BOTS.length)] : PATHS[Math.floor(random() * PATHS.length)];
      const status = bot ? 404 : random() < 0.08 ? 304 : 200;
      const ip = `198.51.100.${Math.floor(random() * 200) + 20}`;
      const bytes = status === 200 ? Math.floor(random() * 9000) + 400 : 0;
      const ua = bot ? "python-requests/2.32" : AGENTS[Math.floor(random() * AGENTS.length)];
      return { text: `${ip} - - [${stamp()}] "GET ${path} HTTP/1.1" ${status} ${bytes} "-" "${ua}"`, error: status >= 400 };
    }
    if (svc.kind === "redis") {
      const ops = ["DB saved on disk", "Background saving started by pid 41", "100 changes in 300 seconds. Saving...", "Background saving terminated with success"];
      return { text: `1:M ${stamp()} * ${ops[Math.floor(random() * ops.length)]}`, error: false };
    }
    const ops =
      svc.kind === "postgres"
        ? ["LOG:  checkpoint starting: time", "LOG:  checkpoint complete: wrote 38 buffers (0.2%)", `LOG:  connection authorized: user=${svc.name === "postgres" ? "shop" : "app"} database=${svc.name === "postgres" ? "shop" : "app"}`, "LOG:  disconnection: session time: 0:00:01.204"]
        : ["[Note] Aborted connection to db: 'blog' (Got timeout reading communication packets)", "[System] InnoDB buffer pool dump started", "[Note] Connection accepted from 10.0.1.12", "[System] InnoDB buffer pool dump completed"];
    const text = ops[Math.floor(random() * ops.length)];
    return { text: `${iso} UTC [${60 + Math.floor(random() * 20)}] ${text}`, error: text.includes("Aborted") };
  }
  function seedLogs(svc: Service) {
    if (svc.logs.length === 0) {
      for (let i = 0; i < 14; i++) {
        svc.logs.push(logLine(svc));
      }
    }
  }
  const visible = (line: LogLine) =>
    (!world.errorsOnly || line.error) && (world.filter === "" || line.text.toLowerCase().includes(world.filter.toLowerCase()));
  function logRow(line: LogLine) {
    const text = esc(line.text);
    return `<li class="${line.error ? "dm-err" : ""}">${text}</li>`;
  }

  // ------------------------------------------------------------------ views
  function counts() {
    const all = world.projects.flatMap((p) => p.services);
    const by = Object.fromEntries(STATES.map((s) => [s, all.filter((x) => x.state === s).length])) as Record<State, number>;
    return by;
  }
  function projectState(p: Project): State {
    const states = p.services.map((s) => s.state);
    for (const s of ["failed", "degraded", "unknown", "progress"] as State[]) {
      if (states.includes(s)) {
        return s;
      }
    }
    if (states.length > 0 && states.every((s) => s === "stopped")) {
      return "stopped";
    }
    return states.length === 0 ? "unknown" : "running";
  }
  function serviceRow(p: string, s: Service) {
    const when = s.versions.length ? T.ago(now() - (s.versions.find((v) => v.n === s.active)?.at ?? now())) : "";
    return `<li class="dm-row">
      ${lamp(s.state)}
      <span class="dm-row__kind">${icon(s.kind)}</span>
      <button type="button" class="dm-link dm-row__name" data-act="service" data-p="${esc(p)}" data-s="${esc(s.name)}" data-key="svc-${esc(p)}-${esc(s.name)}">${esc(s.name)}</button>
      <code class="dm-row__image">${esc(s.image)}</code>
      <span class="dm-row__state">${T.states[s.state]}</span>
      <span class="dm-row__when">${when}</span>
    </li>`;
  }
  function overview() {
    const c = counts();
    const problems = c.failed + c.degraded + c.unknown;
    const summary =
      problems > 0 ? T.problems(problems) : c.progress > 0 ? T.working(c.progress) : T.allClear;
    const summaryState: State = problems > 0 ? "failed" : c.progress > 0 ? "progress" : "running";
    const g = world.gauges;
    const donut = (key: string, value: number) => `<svg class="dm-donut" viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r="18" class="dm-donut__track"/>
        <circle cx="22" cy="22" r="18" class="dm-donut__fill" pathLength="100" stroke-dasharray="${value} 100" data-g="${key}-arc"/>
      </svg>`;
    const memUsed = ((g.mem / 100) * 16).toFixed(1);
    return `<div class="dm-page">
      <div class="dm-head">
        <h3 class="dm-title">${T.nav.overview}</h3>
        <button type="button" class="dm-btn dm-btn--primary" data-act="new-project" data-key="new-project">+ ${T.newProject}</button>
      </div>
      <ul class="dm-summary">
        <li class="dm-summary__lead">${lamp(summaryState, "m")}<strong>${summary}</strong></li>
        ${STATES.map((s) => `<li>${lamp(s)}<span class="dm-num">${c[s]}</span><span class="dm-summary__word">${T.states[s]}</span></li>`).join("")}
      </ul>
      <p class="dm-label">${T.server}</p>
      <div class="dm-gauges">
        <div class="dm-gauge"><p>${T.cpu}</p><div class="dm-gauge__body">${donut("cpu", g.cpu)}<span class="dm-gauge__pct" data-g="cpu">${g.cpu}%</span></div><p class="dm-mono">${T.cores}</p></div>
        <div class="dm-gauge"><p>${T.memory}</p><div class="dm-gauge__body">${donut("mem", g.mem)}<span class="dm-gauge__pct" data-g="mem">${g.mem}%</span></div><p class="dm-mono" data-g="mem-of">${T.memoryOf(memUsed)}</p></div>
        <div class="dm-gauge"><p>${T.disk}</p><div class="dm-gauge__body">${donut("disk", g.disk)}<span class="dm-gauge__pct">${g.disk}%</span></div><p class="dm-mono">${T.diskOf}</p></div>
        <div class="dm-gauge dm-gauge--net"><p>${T.network}</p><svg class="dm-spark" viewBox="0 0 150 40" preserveAspectRatio="none" aria-hidden="true"><path data-g="net-path" d="${spark(g.net)}"/></svg><p class="dm-mono" data-g="net">${netText()}</p></div>
      </div>
      <p class="dm-label">${T.projects}</p>
      <ul class="dm-projects">
        ${world.projects
          .map(
            (p) => `<li class="dm-project">
              <div class="dm-project__head">
                ${lamp(projectState(p))}
                <button type="button" class="dm-link dm-project__name" data-act="project" data-p="${esc(p.name)}" data-key="proj-${esc(p.name)}">${esc(p.name)}</button>
                <span class="dm-muted">${T.services(p.services.length)}</span>
              </div>
              <ul class="dm-rows">${p.services.map((s) => serviceRow(p.name, s)).join("")}</ul>
            </li>`,
          )
          .join("")}
      </ul>
    </div>`;
  }
  function spark(values: number[]) {
    const max = 32;
    return values
      .map((v, i) => `${i === 0 ? "M" : "L"}${((i / (values.length - 1)) * 150).toFixed(1)} ${(40 - (v / max) * 36).toFixed(1)}`)
      .join(" ");
  }
  function netText() {
    const last = world.gauges.net[world.gauges.net.length - 1] ?? 0;
    return T.netInOut(last * 8, Math.round(last * 3.5));
  }
  function projectView(name: string) {
    const p = project(name);
    if (!p) {
      return overview();
    }
    return `<div class="dm-page">
      <button type="button" class="dm-link dm-back" data-act="home" data-key="back">← ${T.back}</button>
      <div class="dm-head">
        <h3 class="dm-title">${icon("project")}${esc(p.name)}</h3>
        <button type="button" class="dm-btn dm-btn--primary" data-act="new-service" data-p="${esc(p.name)}" data-tour="new-service" data-key="new-service">+ ${T.newService}</button>
      </div>
      ${p.services.length ? `<ul class="dm-rows dm-rows--big">${p.services.map((s) => serviceRow(p.name, s)).join("")}</ul>` : `<p class="dm-empty">${T.noServices}</p>`}
    </div>`;
  }
  function tabsOf(s: Service): Tab[] {
    return s.kind === "app" ? ["overview", "deployments", "logs", "domains", "environment"] : ["overview", "backups", "logs"];
  }
  function serviceView(pName: string, sName: string, tab: Tab) {
    const s = find(pName, sName);
    if (!s) {
      return projectView(pName);
    }
    const issued = s.domains.find((d) => d.cert === "issued");
    const actions = [
      s.kind === "app"
        ? `<button type="button" class="dm-btn dm-btn--primary" data-act="deploy" data-key="deploy" ${s.state === "progress" ? "disabled" : ""}>${T.deploy}</button>`
        : "",
      s.state === "stopped"
        ? `<button type="button" class="dm-btn" data-act="start" data-key="start">${T.start}</button>`
        : `<button type="button" class="dm-btn" data-act="stop" data-key="stop" ${s.state === "progress" ? "disabled" : ""}>${T.stop}</button>`,
      `<button type="button" class="dm-btn" data-act="restart" data-key="restart" ${s.state !== "running" ? "disabled" : ""}>${T.restart}</button>`,
      issued && s.state === "running"
        ? `<button type="button" class="dm-btn" data-act="open-site" data-host="${esc(issued.host)}" data-key="open">${T.open} ↗</button>`
        : "",
    ].join("");
    const tabs = tabsOf(s);
    const current = tabs.includes(tab) ? tab : "overview";
    return `<div class="dm-page">
      <button type="button" class="dm-link dm-back" data-act="project" data-p="${esc(pName)}" data-key="back">← ${esc(pName)}</button>
      <div class="dm-svc">
        <div class="dm-svc__id">
          ${lamp(s.state, "l")}
          <div>
            <h3 class="dm-title">${icon(s.kind)}${esc(s.name)}</h3>
            <p class="dm-svc__state"><span>${T.states[s.state]}</span><span class="dm-mono">${s.state === "running" ? T.replicas : T.noReplicas}</span></p>
          </div>
        </div>
        <div class="dm-actions">${actions}</div>
      </div>
      <div class="dm-tabs" role="tablist">
        ${tabs
          .map(
            (t) =>
              `<button type="button" role="tab" id="dm-tab-${t}" aria-controls="dm-panel" aria-selected="${t === current}" tabindex="${t === current ? 0 : -1}" class="dm-tab" data-act="tab" data-tab="${t}" data-tour="tab-${t}" data-key="tab-${t}">${T.tabs[t]}</button>`,
          )
          .join("")}
      </div>
      <div class="dm-panel" role="tabpanel" id="dm-panel" aria-labelledby="dm-tab-${current}">${panel(pName, s, current)}</div>
    </div>`;
  }
  function runBox(s: Service) {
    if (!s.run) {
      return "";
    }
    return `<div class="dm-run">
      <p class="dm-label">${T.output}${s.run.took !== null ? ` · ${T.took(s.run.took)}` : ""}</p>
      <ol class="dm-term" data-dm-run>${s.run.lines.map((l) => `<li>${esc(l)}</li>`).join("")}${s.run.took === null ? '<li class="dm-caret" aria-hidden="true"></li>' : ""}</ol>
    </div>`;
  }
  function panel(p: string, s: Service, tab: Tab) {
    if (tab === "overview") {
      const active = s.versions.find((v) => v.n === s.active);
      const rows =
        s.kind === "app"
          ? [
              [T.imageLabel, `<code>${esc(s.image)}</code>`],
              [T.address, s.domains.length ? s.domains.map((d) => `<code>https://${esc(d.host)}</code>`).join("<br>") : "—"],
              [T.lastDeployment, active ? `#${active.n} · ${T.ago(now() - active.at)}` : T.noDeployment],
            ]
          : [
              [T.engine, `<code>${esc(s.image)}</code>`],
              [T.internal, `<code>${esc(p)}-${esc(s.name)}:${s.kind === "postgres" ? 5432 : s.kind === "mysql" ? 3306 : 6379}</code>`],
              [T.user, `<code>${esc(p)}</code>`],
              [T.password, `<code>••••••••••••</code><span class="dm-note">${T.passwordNote}</span>`],
            ];
      return `<dl class="dm-facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>${runBox(s)}`;
    }
    if (tab === "deployments") {
      const rows = [...s.versions]
        .reverse()
        .map((v) => {
          const active = v.n === s.active;
          const back =
            active || s.state === "progress"
              ? ""
              : `<button type="button" class="dm-btn dm-btn--small" data-act="go-back" data-n="${v.n}" data-key="back-${v.n}" ${world.hint === "go-back" ? 'data-tour="go-back"' : ""}>↺ ${T.goBack}</button>`;
          return `<tr><td>${active ? lamp("running") : '<span class="dm-kept" aria-hidden="true"></span>'}${active ? T.versionState.active : T.versionState.kept}</td><td>#${v.n}</td><td><code>${esc(v.image)}</code></td><td>${T.ago(now() - v.at)}</td><td>${back}</td></tr>`;
        });
      // Only the newest version that can be gone back to carries the tour's marker.
      let marked = false;
      const table = rows.map((r) => {
        if (!marked && r.includes('data-tour="go-back"')) {
          marked = true;
          return r;
        }
        return r.replace(' data-tour="go-back"', "");
      });
      return `<p class="dm-label">${T.versions}</p>
        <div class="dm-scroll"><table class="dm-table"><thead><tr><th>${T.colState}</th><th>${T.colVersion}</th><th>${T.colImage}</th><th>${T.colDeployed}</th><th></th></tr></thead><tbody>${table.join("")}</tbody></table></div>
        ${runBox(s)}`;
    }
    if (tab === "logs") {
      seedLogs(s);
      const lines = s.logs.filter(visible);
      return `<div class="dm-logbar">
          <input type="search" class="dm-input" placeholder="${T.logsFilter}" aria-label="${T.logsFilter}" value="${esc(world.filter)}" data-input="filter" data-key="filter">
          <label class="dm-check"><input type="checkbox" data-input="errors" ${world.errorsOnly ? "checked" : ""}> ${T.errorsOnly}</label>
          <button type="button" class="dm-btn dm-btn--small" data-act="pause" data-key="pause">${world.paused ? T.resume : T.pause}</button>
          <span class="dm-livechip ${world.paused || s.state !== "running" ? "is-off" : ""}">${world.paused ? T.paused : T.live}</span>
        </div>
        <ol class="dm-term dm-term--logs" data-dm-logs>${lines.length ? lines.slice(-200).map(logRow).join("") : `<li class="dm-muted">${T.noMatch}</li>`}</ol>
        ${s.state === "stopped" ? `<p class="dm-note">${T.stoppedLogs}</p>` : ""}`;
    }
    if (tab === "domains") {
      return `<p class="dm-intro">${T.domainsIntro}</p>
        <ul class="dm-domains">${s.domains
          .map((d) => {
            const state: State = d.cert === "issued" ? "running" : "progress";
            const words = d.cert === "issued" ? T.certIssued : d.cert === "checking" ? T.certChecking : T.certRequesting;
            const open =
              d.cert === "issued" && s.state === "running"
                ? `<button type="button" class="dm-link" data-act="open-site" data-host="${esc(d.host)}">${T.open} ↗</button>`
                : "";
            return `<li>${lamp(state)}<code>https://${esc(d.host)}</code><span class="dm-muted">${words}</span>${open}</li>`;
          })
          .join("")}</ul>
        <form class="dm-inline" data-form="domain" novalidate>
          <input class="dm-input" name="host" value="${esc(world.draft)}" placeholder="${T.domainPlaceholder}" aria-label="${T.tabs.domains}" autocomplete="off" spellcheck="false" data-input="domain" data-tour="domain-input" data-key="domain-input">
          <button type="submit" class="dm-btn dm-btn--primary">${T.addDomain}</button>
        </form>
        ${world.domainError ? `<p class="dm-error" role="alert">${world.domainError}</p>` : ""}`;
    }
    if (tab === "environment") {
      return `<p class="dm-intro">${T.envIntro}</p>
        <form data-form="env">
          <textarea class="dm-input dm-code" name="env" rows="5" spellcheck="false" aria-label="${T.tabs.environment}" data-input="env" data-key="env">${esc(s.envDraft ?? s.env)}</textarea>
          <div class="dm-inline"><button type="submit" class="dm-btn dm-btn--primary">${T.save}</button>${s.envSaved ? `<span class="dm-muted" role="status">${T.saved}</span>` : ""}</div>
        </form>`;
    }
    // backups
    const rows = s.backups
      .map((b) => {
        const outcome =
          b.status === "running"
            ? `${lamp("progress")}${T.backupRunning}`
            : b.status === "restoring"
              ? `${lamp("progress")}${T.restoring}`
              : `${lamp("running")}${b.status === "restored" ? T.restored : T.backupDone}`;
        const restore =
          b.status === "done" || b.status === "restored"
            ? `<button type="button" class="dm-btn dm-btn--small" data-act="restore" data-id="${b.id}" data-key="restore-${b.id}">${T.restore}</button>`
            : "";
        return `<tr><td>${T.ago(now() - b.at)}</td><td>${b.status === "running" ? "—" : b.size}</td><td>${outcome}</td><td>${restore}</td></tr>`;
      })
      .reverse()
      .join("");
    return `<p class="dm-intro">${T.backupsIntro}</p>
      <button type="button" class="dm-btn dm-btn--primary" data-act="backup" data-tour="run-backup" data-key="run-backup" ${s.backups.some((b) => b.status === "running") ? "disabled" : ""}>${T.runBackup}</button>
      <div class="dm-scroll"><table class="dm-table"><thead><tr><th>${T.colWhen}</th><th>${T.colSize}</th><th>${T.colOutcome}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function activityView() {
    return `<div class="dm-page">
      <h3 class="dm-title">${T.activityTitle}</h3>
      ${
        world.events.length
          ? `<ul class="dm-events">${world.events.map((e) => `<li>${lamp(e.state)}<span>${esc(e.text)}</span><span class="dm-muted">${T.ago(now() - e.at)}</span></li>`).join("")}</ul>`
          : `<p class="dm-empty">${T.activityEmpty}</p>`
      }
    </div>`;
  }
  function elsewhereView(what: Elsewhere) {
    return `<div class="dm-page dm-elsewhere">
      <h3 class="dm-title">${T.nav[what]}</h3>
      <p class="dm-empty"><strong>${T.notInDemoTitle}.</strong> ${T.notInDemo}</p>
      <a class="dm-btn" href="${DOCS[what]}">${T.readDocs} →</a>
    </div>`;
  }

  function topBar() {
    const v = world.view;
    const crumbs =
      v.name === "service"
        ? `<span>${esc(v.project)}</span><span>${esc(v.service)}</span>`
        : v.name === "project"
          ? `<span>${esc(v.project)}</span>`
          : `<span>${v.name === "activity" ? T.nav.activity : v.name === "elsewhere" ? T.nav[v.what] : T.nav.overview}</span>`;
    const item = (key: "overview" | "activity" | Elsewhere, current: boolean) =>
      `<button type="button" class="dm-nav__item" data-act="nav" data-to="${key}" data-key="nav-${key}" ${current ? 'aria-current="page"' : ""}>${T.nav[key]}</button>`;
    const at = v.name === "elsewhere" ? v.what : v.name === "activity" ? "activity" : "overview";
    return `<div class="dm-bar__brand">
        <svg viewBox="0 0 1024 1024" fill="none" aria-hidden="true"><circle cx="512" cy="512" r="323" stroke="#fff" stroke-width="120"></circle><path d="M480 190.6A323 323 0 0 1 544 190.6" stroke="#E3A33A" stroke-width="120"></path></svg>
        <span>Opsifier</span>
        <span class="dm-bar__crumbs">${crumbs}</span>
      </div>
      <nav class="dm-nav" aria-label="${T.badge}">
        ${item("overview", at === "overview")}${item("activity", at === "activity")}${item("monitor", at === "monitor")}${item("domains", at === "domains")}${item("settings", at === "settings")}
      </nav>
      <div class="dm-bar__end"><span class="dm-badge">${T.badge}</span><span class="dm-mono">v${esc(version)}</span><span class="dm-avatar" aria-hidden="true">D</span></div>`;
  }

  // ------------------------------------------------------------------ painting
  function render() {
    const active = document.activeElement as HTMLElement | null;
    const key = active && root.contains(active) ? active.dataset.key : undefined;
    const selection =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? [active.selectionStart, active.selectionEnd]
        : null;
    bar.innerHTML = topBar();
    const v = world.view;
    main.innerHTML =
      v.name === "overview"
        ? overview()
        : v.name === "project"
          ? projectView(v.project)
          : v.name === "service"
            ? serviceView(v.project, v.service, v.tab)
            : v.name === "activity"
              ? activityView()
              : elsewhereView(v.what);
    for (const el of main.querySelectorAll<HTMLElement>(".is-hint")) {
      el.classList.remove("is-hint");
    }
    if (world.hint) {
      main.querySelector<HTMLElement>(`[data-tour="${world.hint}"]`)?.classList.add("is-hint");
    }
    const box = main.querySelector<HTMLElement>("[data-dm-logs]");
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
    const run = main.querySelector<HTMLElement>("[data-dm-run]");
    if (run) {
      run.scrollTop = run.scrollHeight;
    }
    if (key) {
      const again = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      if (again) {
        again.focus({ preventScroll: true });
        if (selection && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement)) {
          again.setSelectionRange(selection[0], selection[1]);
        }
      }
    }
    paintSteps();
  }
  /** Repaints after a timed change. What is being typed lives in the world, so nothing is lost. */
  function refresh() {
    render();
  }

  // ------------------------------------------------------------------ dialogs
  function openDialog() {
    const d = world.dialog;
    if (!d) {
      dialog.close();
      return;
    }
    let body = "";
    if (d.kind === "service") {
      if (d.step === "kind") {
        body = `<h3>${T.dialogNewService} ${esc(d.project)}</h3>
          <ul class="dm-kinds">${(["app", "postgres", "mysql", "redis"] as Kind[])
            .map(
              (k) =>
                `<li><button type="button" class="dm-kind" data-act="choose" data-kind="${k}" ${k === "app" ? 'data-tour="kind-app"' : ""}>${icon(k)}<span><strong>${T.kinds[k]}</strong><span>${T.kindHelp[k]}</span></span></button></li>`,
            )
            .join("")}</ul>
          <div class="dm-dialog__end"><button type="button" class="dm-btn" data-act="close">${T.cancel}</button></div>`;
      } else {
        const p = project(d.project);
        const taken = new Set(p?.services.map((s) => s.name));
        const base = d.choice === "app" ? "api" : d.choice === "redis" ? "cache" : d.choice;
        let name = base;
        for (let i = 2; taken.has(name); i++) {
          name = `${base}-${i}`;
        }
        const images = ["nginx:1.27-alpine", "traefik/whoami:v1.10", "ghcr.io/acme/api:1.0.0"];
        body = `<h3>${T.dialogNewService} ${esc(d.project)} · ${T.kinds[d.choice]}</h3>
          <form data-form="service" novalidate>
            <label class="dm-field"><span>${T.name}</span><input class="dm-input" name="name" value="${esc(name)}" autocomplete="off" spellcheck="false" required><small>${T.nameHelp}</small></label>
            ${
              d.choice === "app"
                ? `<label class="dm-field"><span>${T.image}</span><input class="dm-input dm-code" name="image" value="${images[0]}" autocomplete="off" spellcheck="false" required><small>${T.imageHelp} ${T.suggestions}: ${images.map((i) => `<button type="button" class="dm-link dm-chip" data-act="pick-image" data-image="${i}">${i}</button>`).join(" ")}</small></label>`
                : ""
            }
            ${d.error ? `<p class="dm-error" role="alert">${d.error}</p>` : ""}
            <div class="dm-dialog__end"><button type="button" class="dm-btn" data-act="close">${T.cancel}</button><button type="submit" class="dm-btn dm-btn--primary">${T.create}</button></div>
          </form>`;
      }
    } else if (d.kind === "project") {
      body = `<h3>${T.dialogNewProject}</h3>
        <form data-form="project" novalidate>
          <label class="dm-field"><span>${T.name}</span><input class="dm-input" name="name" value="" autocomplete="off" spellcheck="false" required><small>${T.nameHelp}</small></label>
          ${d.error ? `<p class="dm-error" role="alert">${d.error}</p>` : ""}
          <div class="dm-dialog__end"><button type="button" class="dm-btn" data-act="close">${T.cancel}</button><button type="submit" class="dm-btn dm-btn--primary">${T.createProject}</button></div>
        </form>`;
    } else {
      body = `<div class="dm-browser">
          <p class="dm-browser__bar"><span aria-hidden="true">🔒</span><code>${esc(d.url)}</code></p>
          <div class="dm-browser__page"><h3>${T.siteTitle}</h3><p>${T.siteBody(esc(d.service), esc(d.image), d.version)}</p></div>
        </div>
        <div class="dm-dialog__end"><button type="button" class="dm-btn" data-act="close">${T.close}</button></div>`;
    }
    dialog.innerHTML = body;
    if (world.hint) {
      dialog.querySelector<HTMLElement>(`[data-tour="${world.hint}"]`)?.classList.add("is-hint");
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    const first = dialog.querySelector<HTMLElement>("input, [data-tour='kind-app'], .dm-kind, button");
    first?.focus();
    if (first instanceof HTMLInputElement) {
      first.select();
    }
  }
  function closeDialog() {
    world.dialog = null;
    if (dialog.open) {
      dialog.close();
    }
  }

  // ------------------------------------------------------------------ what the visitor does
  const NAME = /^[a-z][a-z0-9-]{0,30}$/;
  const IMAGE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/;
  const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

  function act(el: HTMLElement) {
    const v = world.view;
    const here = v.name === "service" ? find(v.project, v.service) : undefined;
    switch (el.dataset.act) {
      case "nav": {
        const to = el.dataset.to as "overview" | "activity" | Elsewhere;
        world.view = to === "overview" ? { name: "overview" } : to === "activity" ? { name: "activity" } : { name: "elsewhere", what: to };
        world.hint = null;
        break;
      }
      case "home":
        world.view = { name: "overview" };
        break;
      case "project":
        world.view = { name: "project", project: el.dataset.p ?? "" };
        if (world.hint !== "new-service") {
          world.hint = null;
        }
        break;
      case "service":
        world.view = { name: "service", project: el.dataset.p ?? "", service: el.dataset.s ?? "", tab: "overview" };
        world.hint = null;
        break;
      case "tab":
        if (v.name === "service") {
          const tab = el.dataset.tab as Tab;
          world.view = { ...v, tab };
          world.domainError = "";
          world.draft = "";
          if (world.hint === `tab-${tab}`) {
            world.hint = null;
          }
          if (tab === "logs") {
            complete(1);
          }
        }
        break;
      case "deploy":
        if (v.name === "service" && here) {
          deploy(v.project, here);
          world.view = { ...v, tab: "deployments" };
        }
        break;
      case "stop":
        if (v.name === "service" && here) {
          stopStart(v.project, here, "stopped");
        }
        break;
      case "start":
      case "restart":
        if (v.name === "service" && here) {
          stopStart(v.project, here, "running");
        }
        break;
      case "go-back":
        if (v.name === "service" && here) {
          goBack(v.project, here, Number(el.dataset.n));
        }
        break;
      case "open-site": {
        if (v.name === "service" && here) {
          const active = here.versions.find((x) => x.n === here.active);
          world.dialog = { kind: "site", url: `https://${el.dataset.host}/`, service: here.name, image: here.image, version: active?.n ?? 1 };
          openDialog();
        }
        return;
      }
      case "pause":
        world.paused = !world.paused;
        break;
      case "backup":
        if (v.name === "service" && here) {
          const b: Backup = { id: world.nextBackup++, at: now(), size: "", status: "running" };
          here.backups.push(b);
          later(2600, () => {
            b.status = "done";
            b.size = `${(18 + random() * 2).toFixed(1)} MB`;
            record(T.events.backup(v.project, here.name), "running");
            say(T.announce.backup(here.name));
            complete(4);
            refresh();
          });
          world.hint = null;
        }
        break;
      case "restore":
        if (v.name === "service" && here) {
          const b = here.backups.find((x) => x.id === Number(el.dataset.id));
          if (b) {
            b.status = "restoring";
            later(2200, () => {
              b.status = "restored";
              record(T.events.restored(v.project, here.name), "running");
              refresh();
            });
          }
        }
        break;
      case "new-project":
        world.dialog = { kind: "project", error: "" };
        openDialog();
        return;
      case "new-service":
        world.dialog = { kind: "service", project: el.dataset.p ?? "", step: "kind", choice: "app", error: "" };
        if (world.hint === "new-service") {
          world.hint = "kind-app";
        }
        openDialog();
        return;
      case "choose":
        if (world.dialog?.kind === "service") {
          world.dialog = { ...world.dialog, step: "form", choice: el.dataset.kind as Kind };
          openDialog();
        }
        return;
      case "pick-image": {
        const input = dialog.querySelector<HTMLInputElement>('input[name="image"]');
        if (input) {
          input.value = el.dataset.image ?? "";
          input.focus();
        }
        return;
      }
      case "close":
        closeDialog();
        return;
      case "show":
        show(Number(el.dataset.step));
        return;
      case "reset":
        for (const id of timers) {
          window.clearTimeout(id);
        }
        timers.clear();
        closeDialog();
        world = initialWorld();
        render();
        return;
      default:
        return;
    }
    render();
  }

  function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const v = world.view;
    if (form.dataset.form === "service" && world.dialog?.kind === "service") {
      const d = world.dialog;
      const p = project(d.project);
      const name = String(data.get("name") ?? "").trim();
      const image = String(data.get("image") ?? "").trim();
      const error = !NAME.test(name)
        ? T.nameInvalid
        : p?.services.some((s) => s.name === name)
          ? T.nameTaken
          : d.choice === "app" && !IMAGE.test(image)
            ? T.imageInvalid
            : "";
      if (error || !p) {
        world.dialog = { ...d, error };
        openDialog();
        return;
      }
      const engines: Record<Exclude<Kind, "app">, string> = { postgres: "postgres:17", mysql: "mysql:8.4", redis: "redis:7.4" };
      const svc: Service = {
        name,
        kind: d.choice,
        image: d.choice === "app" ? image : engines[d.choice],
        state: "progress",
        versions: [],
        active: 0,
        domains: [],
        backups: [],
        env: d.choice === "app" ? "PORT=80\n" : "",
        envDraft: null,
        envSaved: false,
        logs: [],
        run: null,
        mine: true,
      };
      p.services.push(svc);
      closeDialog();
      world.hint = null;
      record(T.events.created(p.name, name), "running");
      if (svc.kind === "app") {
        svc.state = "stopped";
        deploy(p.name, svc, svc.image);
        world.view = { name: "service", project: p.name, service: name, tab: "deployments" };
      } else {
        createDatabase(p.name, svc);
        world.view = { name: "service", project: p.name, service: name, tab: "overview" };
      }
      render();
      return;
    }
    if (form.dataset.form === "project" && world.dialog?.kind === "project") {
      const name = String(data.get("name") ?? "").trim();
      const error = !NAME.test(name) ? T.nameInvalid : project(name) ? T.nameTaken : "";
      if (error) {
        world.dialog = { kind: "project", error };
        openDialog();
        return;
      }
      world.projects.push({ name, services: [] });
      record(T.events.project(name), "running");
      closeDialog();
      world.view = { name: "project", project: name };
      render();
      return;
    }
    if (form.dataset.form === "domain" && v.name === "service") {
      const svc = find(v.project, v.service);
      const host = String(data.get("host") ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!svc) {
        return;
      }
      world.domainError = !HOST.test(host) ? T.domainInvalid : svc.domains.some((d) => d.host === host) ? T.domainTaken : "";
      if (!world.domainError) {
        const d: Domain = { host, cert: "checking", mine: true };
        svc.domains.push(d);
        world.draft = "";
        world.hint = null;
        later(1400, () => {
          d.cert = "requesting";
          refresh();
        });
        later(3000, () => {
          d.cert = "issued";
          record(T.events.domain(host), "running");
          say(T.announce.cert(host));
          complete(2);
          refresh();
        });
      }
      render();
      return;
    }
    if (form.dataset.form === "env" && v.name === "service") {
      const svc = find(v.project, v.service);
      if (svc) {
        svc.env = String(data.get("env") ?? "");
        svc.envDraft = null;
        svc.envSaved = true;
        record(T.events.env(v.project, svc.name), "running");
      }
      render();
    }
  }

  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (target && root.contains(target) && !(target as HTMLButtonElement).disabled) {
      event.preventDefault();
      act(target);
    }
  });
  dialog.addEventListener("click", (event) => {
    // A click on the backdrop closes the dialog, as in the panel.
    if (event.target === dialog) {
      closeDialog();
    }
  });
  dialog.addEventListener("close", () => {
    world.dialog = null;
  });
  root.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    if (form.dataset.form) {
      event.preventDefault();
      submit(form);
    }
  });
  root.addEventListener("input", (event) => {
    const el = event.target as HTMLElement;
    if (el.dataset.input === "domain") {
      world.draft = (el as HTMLInputElement).value;
      return;
    }
    if (el.dataset.input === "env") {
      const v = world.view;
      const svc = v.name === "service" ? find(v.project, v.service) : undefined;
      if (svc) {
        svc.envDraft = (el as HTMLTextAreaElement).value;
        svc.envSaved = false;
      }
      return;
    }
    if (el.dataset.input === "filter") {
      world.filter = (el as HTMLInputElement).value;
      const v = world.view;
      const svc = v.name === "service" ? find(v.project, v.service) : undefined;
      const box = main.querySelector<HTMLElement>("[data-dm-logs]");
      if (svc && box) {
        const lines = svc.logs.filter(visible);
        box.innerHTML = lines.length ? lines.slice(-200).map(logRow).join("") : `<li class="dm-muted">${T.noMatch}</li>`;
        box.scrollTop = box.scrollHeight;
      }
    }
  });
  root.addEventListener("change", (event) => {
    const el = event.target as HTMLInputElement;
    if (el.dataset.input === "errors") {
      world.errorsOnly = el.checked;
      render();
    }
  });
  // Arrow keys move between tabs, as the panel's own tabs do.
  root.addEventListener("keydown", (event) => {
    const el = event.target as HTMLElement;
    if (el.getAttribute("role") !== "tab" || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) {
      return;
    }
    const tabs = [...main.querySelectorAll<HTMLElement>('[role="tab"]')];
    const next = tabs[(tabs.indexOf(el) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    event.preventDefault();
    next?.focus();
    next?.click();
  });

  // ------------------------------------------------------------------ the clock: logs and gauges
  let beat = 0;
  window.setInterval(() => {
    beat += 1;
    const v = world.view;
    // New log lines for every running service; the open one shows them as they come.
    for (const p of world.projects) {
      for (const s of p.services) {
        if (s.state === "running" && s.logs.length > 0 && random() < (s.kind === "app" ? 0.6 : 0.15)) {
          s.logs.push(logLine(s));
          if (s.logs.length > 400) {
            s.logs.splice(0, s.logs.length - 400);
          }
          if (!world.paused && v.name === "service" && v.tab === "logs" && v.project === p.name && v.service === s.name) {
            const box = main.querySelector<HTMLElement>("[data-dm-logs]");
            const line = s.logs[s.logs.length - 1] as LogLine;
            if (box && visible(line)) {
              const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
              box.querySelector(".dm-muted")?.remove();
              box.insertAdjacentHTML("beforeend", logRow(line));
              if (atEnd) {
                box.scrollTop = box.scrollHeight;
              }
            }
          }
        }
      }
    }
    // The server's gauges drift; work in progress shows on the processor.
    if (beat % 3 === 0) {
      const g = world.gauges;
      const busy = counts().progress;
      g.cpu = Math.max(8, Math.min(92, Math.round((busy ? 48 + busy * 9 : 21) + (random() - 0.5) * 8)));
      g.mem = Math.max(30, Math.min(80, Math.round(41 + world.projects.flatMap((p) => p.services).filter((s) => s.mine).length * 2 + (random() - 0.5) * 2)));
      g.net.push(Math.round(10 + random() * 20 + (busy ? 8 : 0)));
      g.net.shift();
      if (v.name === "overview") {
        const set = (key: string, text: string) => {
          const el = main.querySelector<HTMLElement>(`[data-g="${key}"]`);
          if (el) {
            el.textContent = text;
          }
        };
        set("cpu", `${g.cpu}%`);
        set("mem", `${g.mem}%`);
        set("mem-of", T.memoryOf(((g.mem / 100) * 16).toFixed(1)));
        set("net", netText());
        main.querySelector(`[data-g="cpu-arc"]`)?.setAttribute("stroke-dasharray", `${g.cpu} 100`);
        main.querySelector(`[data-g="mem-arc"]`)?.setAttribute("stroke-dasharray", `${g.mem} 100`);
        main.querySelector(`[data-g="net-path"]`)?.setAttribute("d", spark(g.net));
      }
    }
  }, 700);

  render();
}

const root = document.querySelector<HTMLElement>("[data-demo]");
if (root) {
  startDemo(root);
}
