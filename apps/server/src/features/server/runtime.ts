import { systemLogsTopic } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import type { TopicChannel, TopicFeed, TopicProvider } from "../../core/realtime";
import { PROXY_SERVICE } from "../projects/network";
import { LogFeed } from "../service-runtime/logs";
import { getSetting, putSetting } from "../system/repo";
import { PANEL_SERVICE } from "./disk";
import { enqueueDailyCleanup } from "./docker-admin";
import { getDailyCleanup } from "./settings";

const LAST_RUN_KEY = "daily_docker_cleanup_last_run";
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Runs the ownership-limited cleanup once a day, when it is on. */
class DailyCleanupRunner {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: AppDeps) {}

  start(): void {
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Public so that a test can run what the timer runs. */
  check(): void {
    const { deps } = this;
    try {
      if (!getDailyCleanup(deps)) {
        return;
      }
      const last = getSetting(deps.db, LAST_RUN_KEY);
      const now = deps.now();
      if (typeof last === "number" && now - last < DAY_MS) {
        return;
      }
      putSetting(deps.db, LAST_RUN_KEY, now, new Date(now));
      enqueueDailyCleanup(deps);
    } catch (error) {
      if (!(error instanceof DockerDriverError)) {
        deps.logger.warn({ err: error }, "Could not start the daily Docker cleanup");
      }
    }
  }
}

const runners = new WeakMap<AppDeps, DailyCleanupRunner>();

export function createDailyCleanupRunner(deps: AppDeps): DailyCleanupRunner {
  let runner = runners.get(deps);
  if (runner === undefined) {
    runner = new DailyCleanupRunner(deps);
    runners.set(deps, runner);
  }
  return runner;
}

const SYSTEM_SERVICES: Record<string, string> = {
  [systemLogsTopic("panel")]: PANEL_SERVICE,
  [systemLogsTopic("proxy")]: PROXY_SERVICE,
};

/** Live logs of the panel and the proxy, through the same feed as any service's. */
export function createPanelLogsProvider(deps: Pick<AppDeps, "docker" | "logger">): TopicProvider {
  return {
    matches: (topic) => topic in SYSTEM_SERVICES,
    open(topic: string, channel: TopicChannel): TopicFeed {
      return new LogFeed({
        docker: deps.docker,
        logger: deps.logger,
        name: SYSTEM_SERVICES[topic] as string,
        channel,
      });
    },
  };
}
