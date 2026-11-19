import { isIP } from "node:net";

/**
 * The server's name on sslip.io: an IPv4 address as it is, an IPv6 one in lowercase with dashes for
 * colons, and a leading zero where it would start with a dash, which no DNS label can. Every name the
 * panel makes from the server's address goes through here, so that they all agree with each other.
 */
export function sslipBase(ip: string): string {
  if (isIP(ip) !== 6) {
    return `${ip}.sslip.io`;
  }
  const dashed = ip.toLowerCase().replaceAll(":", "-");
  return `${dashed.startsWith("-") ? `0${dashed}` : dashed}.sslip.io`;
}
