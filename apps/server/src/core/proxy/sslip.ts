import { isIP } from "node:net";

/**
 * The server's name on sslip.io: an IPv4 address as it is, an IPv6 one in lowercase with dashes for
 * colons, and a zero where it would start or end with a dash, which no DNS label can. Every name the
 * panel makes from the server's address goes through here, so that they all agree with each other.
 */
export function sslipBase(ip: string): string {
  if (isIP(ip) !== 6) {
    return `${ip}.sslip.io`;
  }
  const dashed = ip.toLowerCase().replaceAll(":", "-");
  // A label can neither start nor end with a dash: sslip.io reads a zero there as the same address.
  return `${dashed.startsWith("-") ? "0" : ""}${dashed}${dashed.endsWith("-") ? "0" : ""}.sslip.io`;
}
