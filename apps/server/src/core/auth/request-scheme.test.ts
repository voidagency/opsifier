import { BlockList } from "node:net";
import { describe, expect, it } from "vitest";
import { resolveRequestScheme } from "./client-ip";
import { isOriginAllowed } from "./origin";

const proxies = new BlockList();
proxies.addSubnet("10.0.0.0", 8, "ipv4");
const none = new Set<string>();

describe("resolveRequestScheme", () => {
  const plain = { encrypted: false, peer: "203.0.113.5", forwardedProto: undefined };

  it("says https when TLS ended here", () => {
    expect(resolveRequestScheme({ ...plain, encrypted: true }, new BlockList())).toBe("https");
  });

  it("says http when nothing says otherwise", () => {
    expect(resolveRequestScheme(plain, proxies)).toBe("http");
  });

  it("believes the header from a trusted proxy", () => {
    const signals = { encrypted: false, peer: "10.0.0.2", forwardedProto: "https" };
    expect(resolveRequestScheme(signals, proxies)).toBe("https");
    expect(resolveRequestScheme({ ...signals, peer: "::ffff:10.0.0.2" }, proxies)).toBe("https");
  });

  it("ignores the header from anyone else", () => {
    expect(resolveRequestScheme({ ...plain, forwardedProto: "https" }, proxies)).toBe("http");
    expect(resolveRequestScheme({ ...plain, peer: undefined, forwardedProto: "https" }, proxies)).toBe(
      "http",
    );
  });

  it("reads only the entry the nearest proxy added, so a client cannot prepend its way in", () => {
    const signals = { encrypted: false, peer: "10.0.0.2" };
    expect(resolveRequestScheme({ ...signals, forwardedProto: "https, http" }, proxies)).toBe("http");
    expect(resolveRequestScheme({ ...signals, forwardedProto: "http, HTTPS" }, proxies)).toBe("https");
  });

  it("reads the wss a proxy such as Traefik sends on a WebSocket upgrade as https", () => {
    const signals = { encrypted: false, peer: "10.0.0.2" };
    expect(resolveRequestScheme({ ...signals, forwardedProto: "wss" }, proxies)).toBe("https");
    expect(resolveRequestScheme({ ...signals, forwardedProto: "WSS" }, proxies)).toBe("https");
    expect(resolveRequestScheme({ ...signals, forwardedProto: "ws" }, proxies)).toBe("http");
    expect(resolveRequestScheme({ ...plain, forwardedProto: "wss" }, proxies)).toBe("http");
  });
});

describe("isOriginAllowed", () => {
  const check = (origin: string, scheme: "http" | "https", host = "panel.example.com") =>
    isOriginAllowed(origin, { host, scheme }, none);

  it("needs the scheme to match as well as the host", () => {
    expect(check("https://panel.example.com", "https")).toBe(true);
    expect(check("http://panel.example.com", "http")).toBe(true);
    expect(check("http://panel.example.com", "https")).toBe(false);
    expect(check("https://panel.example.com", "http")).toBe(false);
  });

  it("strips only the port that is the default for the scheme", () => {
    expect(check("https://panel.example.com", "https", "panel.example.com:443")).toBe(true);
    expect(check("http://panel.example.com", "http", "panel.example.com:80")).toBe(true);
    expect(check("https://panel.example.com:80", "https", "panel.example.com:80")).toBe(true);
    expect(check("https://panel.example.com", "https", "panel.example.com:80")).toBe(false);
  });

  it("lets an explicitly allowed origin through on any scheme", () => {
    const allowed = new Set(["https://admin.example.com"]);
    expect(isOriginAllowed("https://admin.example.com", { host: "x", scheme: "http" }, allowed)).toBe(true);
  });
});
