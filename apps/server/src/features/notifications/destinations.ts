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
  ["64:ff9b::", 96],
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

/** Addresses a request from this server should not reach unless the owner has said so. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return blocked.check(address, "ipv4");
  }
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    return mapped === undefined ? blocked.check(address, "ipv6") : blocked.check(mapped, "ipv4");
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
