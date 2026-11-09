// @vitest-environment jsdom
import type { ServiceStatus, ServiceSummary } from "@opsifier/contract";
import { describe, expect, it } from "vitest";
import "../../testing/browser-stubs";
import { i18n } from "../../i18n";
import {
  serviceCounts,
  servicePictogram,
  serviceState,
  serviceStateLabel,
  servicesState,
  serviceTypeLabel,
  sortServices,
  stateRank,
} from "./serviceState";

const t = i18n.getFixedT("en");

const service = (status: ServiceStatus, overrides: Partial<ServiceSummary> = {}): ServiceSummary => ({
  projectName: "shop",
  name: status,
  type: "app",
  status,
  replicas: { running: status === "running" ? 1 : 0, desired: 1 },
  activeAction: null,
  runtimeUncertain: null,
  wake: [],
  lastDeployedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("serviceStateLabel", () => {
  it("says what state the service is in", () => {
    expect(serviceStateLabel(service("running"), t)).toBe("Running");
    expect(serviceStateLabel(service("stopped"), t)).toBe("Stopped");
    expect(serviceStateLabel(service("failing"), t)).toBe("Failed");
  });

  it("says degraded when part of a failing service is still up", () => {
    const partly = service("failing", { replicas: { running: 1, desired: 2 } });
    expect(serviceState(partly)).toBe("degraded");
    expect(serviceStateLabel(partly, t)).toBe("Degraded");
  });

  it("is more exact than the state where the status is", () => {
    expect(serviceStateLabel(service("undeployed"), t)).toBe("Not deployed");
    expect(serviceStateLabel(service("starting"), t)).toBe("Starting");
    expect(serviceStateLabel(service("unknown"), t)).toBe("Status unavailable");
  });

  it("names the work when there is some, whatever the status", () => {
    const busy = service("running", { activeAction: { id: "a1", type: "service.deploy" } });
    expect(serviceState(busy)).toBe("progress");
    expect(serviceStateLabel(busy, t)).toBe("Deployment in progress");
  });
});

describe("the order of services", () => {
  it("puts problems first, then by name", () => {
    const sorted = sortServices([
      service("running", { name: "b" }),
      service("stopped", { name: "a" }),
      service("failing", { name: "z" }),
      service("running", { name: "a" }),
    ]);
    expect(sorted.map(({ name, status }) => `${status}:${name}`)).toEqual([
      "failing:z",
      "running:a",
      "running:b",
      "stopped:a",
    ]);
  });

  it("ranks nothing at all last", () => {
    expect(stateRank("failed")).toBeLessThan(stateRank("stopped"));
    expect(stateRank("stopped")).toBeLessThan(stateRank(null));
  });
});

describe("rolling services up", () => {
  it("counts them by state", () => {
    expect(serviceCounts([service("running"), service("running"), service("failing")])).toEqual({
      running: 2,
      failed: 1,
    });
  });

  it("takes the worst state, or none when there are no services", () => {
    expect(servicesState([service("running"), service("failing")])).toBe("failed");
    expect(servicesState([])).toBeNull();
  });
});

describe("pictograms and names of types", () => {
  it("draws every type of service, and an app for one it doesn't know", () => {
    expect(servicePictogram("postgres")).toBe("postgres");
    expect(servicePictogram("compose")).toBe("compose");
    expect(servicePictogram("something-new")).toBe("app");
  });

  it("names a type, or falls back to what the server calls it", () => {
    expect(serviceTypeLabel("mariadb", t)).toBe("MariaDB");
    expect(serviceTypeLabel("something-new", t)).toBe("something-new");
  });
});
