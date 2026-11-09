import type { DockerEvent, DockerEventFrame } from "@opsifier/contract";
import { dockerEventsTopic } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError, type EngineEvent } from "../../core/docker";
import type { TopicChannel, TopicFeed, TopicProvider } from "../../core/realtime";

/** Noise from health checks and terminals that says nothing about the state of anything. */
const IGNORED_ACTIONS = /^(exec_(create|start|die|detach)|top)/;
const RING_SIZE = 200;
const RETRY_MS = 2000;

class EventsFeed implements TopicFeed {
  private readonly controller = new AbortController();
  private readonly ring: DockerEvent[] = [];
  private seq = 0;
  private available = true;

  constructor(
    private readonly docker: AppDeps["docker"],
    private readonly channel: TopicChannel,
    private readonly logger: AppDeps["logger"],
  ) {
    void this.run();
  }

  close(): void {
    this.controller.abort();
  }

  replay(): readonly unknown[] {
    const frame: DockerEventFrame = { kind: "snapshot", available: this.available, events: [...this.ring] };
    return [frame];
  }

  private setAvailable(available: boolean): void {
    if (available !== this.available) {
      this.available = available;
      const frame: DockerEventFrame = { kind: "state", available };
      this.channel.publish(frame);
    }
  }

  private async run(): Promise<void> {
    const { signal } = this.controller;
    while (!signal.aborted) {
      try {
        for await (const event of this.docker.events({ signal })) {
          this.setAvailable(true);
          this.accept(event);
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (error instanceof DockerDriverError) {
          this.setAvailable(false);
        } else {
          this.logger.warn({ err: error }, "Could not follow Docker events");
        }
      }
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RETRY_MS);
          timer.unref();
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }
  }

  private accept(event: EngineEvent): void {
    if (IGNORED_ACTIONS.test(event.action)) {
      return;
    }
    const entry: DockerEvent = {
      seq: this.seq,
      type: event.type,
      action: event.action,
      actorId: event.actorId,
      attributes: event.attributes,
      scope: event.scope,
      at: new Date(event.at).toISOString(),
    };
    this.seq += 1;
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) {
      this.ring.shift();
    }
    const frame: DockerEventFrame = { kind: "event", event: entry };
    this.channel.publish(frame);
  }
}

export function createEventsProvider(deps: Pick<AppDeps, "docker" | "logger">): TopicProvider {
  return {
    matches: (topic) => topic === dockerEventsTopic,
    open: (_topic, channel) => new EventsFeed(deps.docker, channel, deps.logger),
  };
}
