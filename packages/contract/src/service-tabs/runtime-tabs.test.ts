import { describe, expect, it } from "vitest";
import { deploySettings, parseSysctlText, portSpec, splitList } from "./advanced";
import { resourcesSpec } from "./resources";
import { scriptSpec } from "./scripts";
import { isCleanAbsolutePath, mountSpec } from "./storage";

describe("paths", () => {
  it.each(["/", "/a", "/a/b.c", "/a b/c", "/srv/my-app_1"])("accepts %j", (path) => {
    expect(isCleanAbsolutePath(path)).toBe(true);
  });

  it.each([
    "",
    "a",
    "a/b",
    "./a",
    "/a/",
    "/a//b",
    "/a/./b",
    "/a/../b",
    "/..",
    "/a\nb",
    "/a\tb",
    `/a${"\0"}b`,
  ])("refuses %j", (path) => {
    expect(isCleanAbsolutePath(path)).toBe(false);
  });
});

describe("the mount schemas", () => {
  it("accepts the three kinds", () => {
    expect(mountSpec.parse({ type: "bind", hostPath: "/srv", mountPath: "/data" })).toEqual({
      type: "bind",
      hostPath: "/srv",
      mountPath: "/data",
      acknowledgeRisk: false,
    });
    expect(mountSpec.parse({ type: "volume", name: "data-1", mountPath: "/data" }).type).toBe("volume");
    expect(mountSpec.parse({ type: "file", mountPath: "/etc/app.conf" })).toEqual({
      type: "file",
      mountPath: "/etc/app.conf",
      content: "",
    });
  });

  it.each(["/", "/proc", "/proc/x", "/sys", "/sys/kernel", "/dev"])(
    "refuses a container path over %s",
    (mountPath) => {
      expect(mountSpec.safeParse({ type: "volume", name: "a", mountPath }).success).toBe(false);
    },
  );

  it("still allows a device under /dev and a host path of /", () => {
    expect(mountSpec.safeParse({ type: "volume", name: "a", mountPath: "/dev/shm" }).success).toBe(true);
    expect(mountSpec.safeParse({ type: "bind", hostPath: "/", mountPath: "/host" }).success).toBe(true);
  });
});

describe("resources", () => {
  it("accepts the documented values and zero", () => {
    expect(
      resourcesSpec.safeParse({
        memoryReservation: 64,
        memoryLimit: 128,
        cpuReservation: 0.1,
        cpuLimit: 0.5,
      }).success,
    ).toBe(true);
    expect(resourcesSpec.parse({})).toEqual({
      memoryReservation: 0,
      memoryLimit: 0,
      cpuReservation: 0,
      cpuLimit: 0,
    });
  });

  it("allows a reservation with no limit at all", () => {
    expect(resourcesSpec.safeParse({ memoryReservation: 256, cpuReservation: 2 }).success).toBe(true);
  });
});

describe("ports", () => {
  it("defaults to TCP", () => {
    expect(portSpec.parse({ published: 30080, target: 80 }).protocol).toBe("tcp");
  });

  it("accepts the two ends of the range", () => {
    expect(portSpec.safeParse({ published: 1, target: 65535 }).success).toBe(true);
  });
});

describe("deploy settings", () => {
  it("accepts every known capability and a namespaced sysctl", () => {
    expect(
      deploySettings.safeParse({
        capAdd: ["NET_ADMIN", "SYS_PTRACE", "ALL"],
        capDrop: ["MKNOD"],
        sysctls: {
          "net.ipv4.tcp_rmem": "4096 87380 6291456",
          "kernel.shmmax": "1",
          "fs.mqueue.msg_max": "10",
        },
      }).success,
    ).toBe(true);
  });

  it("refuses a blank command but accepts none", () => {
    expect(deploySettings.safeParse({ command: "  " }).success).toBe(false);
    expect(deploySettings.parse({ command: null }).command).toBeNull();
    expect(deploySettings.parse({ command: " sleep 1 " }).command).toBe("sleep 1");
  });
});

describe("scripts", () => {
  it.each(["Clear cache", "backup_db", "dépôt-1", "v1.2"])("accepts the name %j", (name) => {
    expect(scriptSpec.safeParse({ name, script: "ls" }).success).toBe(true);
  });

  it.each(["", " ", "a;b", "a/b", ".hidden", "name-"])("refuses the name %j", (name) => {
    expect(scriptSpec.safeParse({ name, script: "ls" }).success).toBe(false);
  });
});

describe("text as typed in a form", () => {
  it("splits lists on commas and lines, dropping blanks", () => {
    expect(splitList(" NET_ADMIN, ,SYS_MODULE\nCHOWN,")).toEqual(["NET_ADMIN", "SYS_MODULE", "CHOWN"]);
    expect(splitList("")).toEqual([]);
  });

  it("reads sysctls, and keeps a value that contains a comma", () => {
    expect(parseSysctlText("net.ipv4.ip_local_reserved_ports=8080,9148, net.core.somaxconn=1024")).toEqual({
      "net.ipv4.ip_local_reserved_ports": "8080,9148",
      "net.core.somaxconn": "1024",
    });
    expect(parseSysctlText("kernel.sem=250 32000 32 128")).toEqual({ "kernel.sem": "250 32000 32 128" });
  });

  it("keeps a pair with no value so that validation can name it", () => {
    expect(parseSysctlText("net.core.somaxconn")).toEqual({ "net.core.somaxconn": "" });
    expect(parseSysctlText("")).toEqual({});
  });
});
