/**
 * The two things the service needs from AWS, as small interfaces. `aws.ts` implements them for real and
 * `fakes.ts` in memory, with the same conditional writes and the same Route 53 rules.
 */

export type RecordType = "A" | "TXT";

export interface RecordSet {
  /** Lowercase, no trailing dot, `*` spelled as `*`. */
  name: string;
  type: RecordType;
  ttl: number;
  /** TXT values without their quotes. */
  values: readonly string[];
}

export interface DnsChange {
  /** UPSERT is safe to repeat. DELETE fails unless the name, TTL and values all match exactly. */
  action: "UPSERT" | "DELETE";
  record: RecordSet;
}

export interface Dns {
  /** Everything the zone holds at `name` or below it. */
  list(name: string): Promise<RecordSet[]>;
  /** One Route 53 change batch: every change is applied, or none. */
  change(changes: readonly DnsChange[]): Promise<void>;
}

export type FinalStatus = "released" | "disabled" | "expired" | "refused";
/** `requested` holds a name and no records. Only an operator's approval takes it to `active`. */
export type ServerStatus = "requested" | "active" | "removing" | FinalStatus;

export interface ServerRecord {
  id: string;
  status: ServerStatus;
  /** SHA-256 of the secret, never the secret. Absent once the address has been given up. */
  secretHash?: string;
  /** Where the records point. Absent once they are gone. */
  ip?: string;
  /** Milliseconds. */
  createdAt: number;
  /** Milliseconds. */
  lastSeen: number;
  /** Set while `removing`: where it ends up. */
  removeTo?: FinalStatus;
  /** Who asked, for whoever decides. Absent once the row is a tombstone. */
  email?: string;
  /** What they said it is for. Absent once the row is a tombstone. */
  purpose?: string;
}

export interface ServerPatch {
  status?: ServerStatus;
  ip?: string | null;
  lastSeen?: number;
  secretHash?: null;
  removeTo?: FinalStatus | null;
  email?: null;
  purpose?: null;
}

/** A hold on one server, so that a change in DNS and the row that describes it can't be overtaken. */
export interface Lease {
  id: string;
  token: string;
}

export type LeaseOutcome = "leased" | "busy" | "refused";

export interface ServerPage {
  servers: ServerRecord[];
  /** Absent on the last page. */
  cursor?: string;
}

export interface Store {
  /** Creates the row only if the ID has never been used. False if it has, in any status. */
  create(server: ServerRecord): Promise<boolean>;
  get(id: string): Promise<ServerRecord | null>;
  /** Refreshes `lastSeen`, only while active and still at this address. */
  touch(id: string, ip: string, at: number): Promise<boolean>;
  /** Takes the lease if the status is one of these and nobody else holds it. `until` bounds a crash. */
  lease(lease: Lease, statuses: readonly ServerStatus[], now: number, until: number): Promise<LeaseOutcome>;
  /** Writes these fields, as long as this lease still holds. False if it no longer does. */
  update(lease: Lease, patch: ServerPatch): Promise<boolean>;
  unlease(lease: Lease): Promise<void>;
  /** Counts one more against `limit`, atomically. False once the limit is reached. */
  hit(key: string, limit: number, expiresAtSeconds: number): Promise<boolean>;
  scan(cursor?: string): Promise<ServerPage>;
}
