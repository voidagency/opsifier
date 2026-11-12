import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::1", 128],
  ["::", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

/** The NAT64 well-known prefix (RFC 6052). Its addresses carry an IPv4 address in their last 32 bits. */
const nat64 = new BlockList();
nat64.addSubnet("64:ff9b::", 96, "ipv6");

/** The eight 16-bit groups of an IPv6 address, in any of the ways it can be written. */
function ipv6Groups(address: string): number[] {
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text =
    dotted === null
      ? address
      : `${dotted[1]}${((Number(dotted[2]) << 8) | Number(dotted[3])).toString(16)}:${((Number(dotted[4]) << 8) | Number(dotted[5])).toString(16)}`;
  const [head = "", tail] = text.split("::");
  const groups = (side: string) =>
    side === "" ? [] : side.split(":").map((group) => Number.parseInt(group, 16));
  const before = groups(head);
  if (tail === undefined) {
    return before;
  }
  const after = groups(tail);
  return [...before, ...new Array<number>(8 - before.length - after.length).fill(0), ...after];
}

/** The IPv4 address a NAT64 address reaches. */
function nat64Target(address: string): string {
  const [high = 0, low = 0] = ipv6Groups(address).slice(6);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** Addresses a request from this server should not reach unless the owner has said so. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return blocked.check(address, "ipv4");
  }
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped !== undefined) {
      return blocked.check(mapped, "ipv4");
    }
    // A network with DNS64 gives every name without an IPv6 address of its own a NAT64 one, so the
    // IPv4 address it reaches is what decides: refusing them all would refuse half the internet.
    if (nat64.check(address, "ipv6")) {
      return blocked.check(nat64Target(address), "ipv4");
    }
    return blocked.check(address, "ipv6");
  }
  return true;
}

export class DestinationError extends Error {
  override readonly name = "DestinationError";
}

export interface ResolvedDestination {
  address: string;
  family: 4 | 6;
}

/**
 * Resolves a destination and refuses a private one unless the owner allows them. The caller connects
 * to the address returned here, so a name cannot resolve one way now and another way when it connects.
 */
export async function resolveDestination(
  hostname: string,
  options: { allowPrivate: boolean },
): Promise<ResolvedDestination> {
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  const literal = isIP(host);
  const addresses =
    literal !== 0
      ? [{ address: host, family: literal as 4 | 6 }]
      : ((await dnsLookup(host, { all: true, verbatim: true }).catch(() => {
          throw new DestinationError(`The name ${host} could not be resolved.`);
        })) as Array<{ address: string; family: 4 | 6 }>);

  if (addresses.length === 0) {
    throw new DestinationError(`The name ${host} could not be resolved.`);
  }
  if (!options.allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new DestinationError("This destination is on a private address, which the owner has not allowed.");
  }
  return addresses[0] as ResolvedDestination;
}
