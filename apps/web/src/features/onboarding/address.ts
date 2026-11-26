/** IPv4 ranges no browser outside the server's own network can reach, nor a certificate authority. */
const PRIVATE_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // 192.0.2.0/24
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15
  [0xc6336400, 24], // 198.51.100.0/24
  [0xcb007100, 24], // 203.0.113.0/24
  [0xe0000000, 4], // 224.0.0.0/4
  [0xf0000000, 4], // 240.0.0.0/4
];

function ipv4Number(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return null;
  }
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0);
}

/**
 * Whether an address can only be reached from the server's own network: then names generated from it,
 * under sslip.io, lead nowhere for anyone else, and no certificate can be issued for them.
 */
export function isPrivateIp(ip: string): boolean {
  const v4 = ipv4Number(ip);
  if (v4 !== null) {
    return PRIVATE_V4.some(([base, bits]) => v4 >>> (32 - bits) === base >>> (32 - bits));
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1];
  if (mapped !== undefined) {
    return isPrivateIp(mapped);
  }
  return (
    v6 === "::" ||
    v6 === "::1" ||
    /^f[cd]/.test(v6) || // fc00::/7
    /^fe[89ab]/.test(v6) || // fe80::/10
    /^ff/.test(v6) || // multicast
    v6.startsWith("2001:db8:") ||
    v6.startsWith("2001:0db8:")
  );
}

/** The server's name on sslip.io, written as the panel writes it, IPv6 with dashes. */
export function sslipBase(ip: string): string {
  if (!ip.includes(":")) {
    return `${ip}.sslip.io`;
  }
  const dashed = ip.toLowerCase().replaceAll(":", "-");
  return `${dashed.startsWith("-") ? "0" : ""}${dashed}${dashed.endsWith("-") ? "0" : ""}.sslip.io`;
}

/** One way of writing an address, IPv6 in lower case with its zeros left out, as the server keeps it. */
export function canonicalIp(ip: string): string {
  if (!ip.includes(":")) {
    return ip;
  }
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return ip.toLowerCase();
  }
}
