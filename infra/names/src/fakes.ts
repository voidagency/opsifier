import type {
  Dns,
  DnsChange,
  Lease,
  LeaseOutcome,
  RecordSet,
  ServerPage,
  ServerPatch,
  ServerRecord,
  ServerStatus,
  Store,
} from "./ports";

/** Lets concurrent callers interleave, as they would against a real service. */
const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

export class InvalidChangeBatch extends Error {
  override readonly name = "InvalidChangeBatch";
}

/** What Route 53 does with a change batch: all or nothing, with DELETE matching exactly. */
export class FakeDns implements Dns {
  readonly records = new Map<string, RecordSet>();
  readonly batches: DnsChange[][] = [];
  /** Fails the next batch. `applied` is the ambiguous case: it took effect, but the answer was lost. */
  failNext: "before" | "applied" | null = null;
  /** Fails every operation from now on, like an outage. */
  down = false;

  private key(name: string, type: string): string {
    return `${name}|${type}`;
  }

  get(name: string, type: RecordSet["type"]): RecordSet | undefined {
    return this.records.get(this.key(name, type));
  }

  private validated(changes: readonly DnsChange[]): void {
    for (const { action, record } of changes) {
      const existing = this.get(record.name, record.type);
      if (action !== "DELETE") {
        continue;
      }
      if (
        existing === undefined ||
        existing.ttl !== record.ttl ||
        [...existing.values].sort().join() !== [...record.values].sort().join()
      ) {
        throw new InvalidChangeBatch(`Tried to delete ${record.name}, but it does not match.`);
      }
    }
  }

  private apply(changes: readonly DnsChange[]): void {
    for (const { action, record } of changes) {
      if (action === "DELETE") {
        this.records.delete(this.key(record.name, record.type));
      } else {
        this.records.set(this.key(record.name, record.type), { ...record, values: [...record.values] });
      }
    }
  }

  async list(name: string): Promise<RecordSet[]> {
    await yieldNow();
    if (this.down) {
      throw new Error("Route 53 is down");
    }
    return [...this.records.values()]
      .filter((record) => record.name === name || record.name.endsWith(`.${name}`))
      .map((record) => ({ ...record, values: [...record.values] }));
  }

  async change(changes: readonly DnsChange[]): Promise<void> {
    await yieldNow();
    if (this.down) {
      throw new Error("Route 53 is down");
    }
    const failure = this.failNext;
    this.failNext = null;
    if (failure === "before") {
      throw new Error("Throttling");
    }
    this.validated(changes);
    this.apply(changes);
    this.batches.push([...changes]);
    if (failure === "applied") {
      throw new Error("The connection dropped after the change was accepted");
    }
  }
}

interface StoredServer extends ServerRecord {
  leaseToken?: string;
  leaseUntil?: number;
}

type FailableMethod = "createPending" | "activate" | "update" | "deleteRow" | "get";

/** The same conditional writes as DynamoDB, evaluated atomically one call at a time. */
export class FakeStore implements Store {
  readonly servers = new Map<string, StoredServer>();
  readonly counters = new Map<string, number>();
  private readonly failures = new Map<FailableMethod, number>();
  private readonly lostAnswers = new Set<FailableMethod>();

  /** Fails the next `times` calls of one method, before they take effect. */
  failNext(method: FailableMethod, times = 1): void {
    this.failures.set(method, times);
  }

  /** The next call of this method takes effect and then reports a failure, like a lost response. */
  loseNextAnswer(method: FailableMethod): void {
    this.lostAnswers.add(method);
  }

  private maybeFail(method: FailableMethod): void {
    const remaining = this.failures.get(method) ?? 0;
    if (remaining > 0) {
      this.failures.set(method, remaining - 1);
      throw new Error(`${method} failed`);
    }
  }

  private maybeLoseAnswer(method: FailableMethod): void {
    if (this.lostAnswers.delete(method)) {
      throw new Error(`The answer to ${method} was lost`);
    }
  }

  private held(server: StoredServer, lease: Lease): boolean {
    return server.leaseToken === lease.token;
  }

  async createPending(server: ServerRecord): Promise<boolean> {
    await yieldNow();
    this.maybeFail("createPending");
    if (this.servers.has(server.id)) {
      return false;
    }
    this.servers.set(server.id, { ...server });
    return true;
  }

  async get(id: string): Promise<ServerRecord | null> {
    await yieldNow();
    this.maybeFail("get");
    const server = this.servers.get(id);
    return server === undefined ? null : { ...server };
  }

  async activate(id: string, at: number): Promise<boolean> {
    await yieldNow();
    this.maybeFail("activate");
    const server = this.servers.get(id);
    if (server?.status !== "pending") {
      return false;
    }
    server.status = "active";
    server.lastSeen = at;
    this.maybeLoseAnswer("activate");
    return true;
  }

  async touch(id: string, ip: string, at: number): Promise<boolean> {
    await yieldNow();
    const server = this.servers.get(id);
    if (server?.status !== "active" || server.ip !== ip) {
      return false;
    }
    server.lastSeen = at;
    return true;
  }

  async lease(
    lease: Lease,
    statuses: readonly ServerStatus[],
    now: number,
    until: number,
  ): Promise<LeaseOutcome> {
    await yieldNow();
    const server = this.servers.get(lease.id);
    if (server === undefined || !statuses.includes(server.status)) {
      return "refused";
    }
    if (server.leaseUntil !== undefined && server.leaseUntil > now) {
      return "busy";
    }
    server.leaseToken = lease.token;
    server.leaseUntil = until;
    return "leased";
  }

  async update(lease: Lease, patch: ServerPatch): Promise<boolean> {
    await yieldNow();
    this.maybeFail("update");
    const server = this.servers.get(lease.id);
    if (server === undefined || !this.held(server, lease)) {
      return false;
    }
    if (patch.status !== undefined) {
      server.status = patch.status;
    }
    if (patch.lastSeen !== undefined) {
      server.lastSeen = patch.lastSeen;
    }
    if (patch.ip === null) {
      delete server.ip;
    } else if (patch.ip !== undefined) {
      server.ip = patch.ip;
    }
    if (patch.removeTo === null) {
      delete server.removeTo;
    } else if (patch.removeTo !== undefined) {
      server.removeTo = patch.removeTo;
    }
    if (patch.secretHash === null) {
      delete server.secretHash;
    }
    this.maybeLoseAnswer("update");
    return true;
  }

  async unlease(lease: Lease): Promise<void> {
    await yieldNow();
    const server = this.servers.get(lease.id);
    if (server !== undefined && this.held(server, lease)) {
      delete server.leaseToken;
      delete server.leaseUntil;
    }
  }

  async deleteRow(id: string, statuses: readonly ServerStatus[]): Promise<boolean> {
    await yieldNow();
    this.maybeFail("deleteRow");
    const server = this.servers.get(id);
    if (server === undefined || !statuses.includes(server.status)) {
      return false;
    }
    this.servers.delete(id);
    return true;
  }

  async hit(key: string, limit: number): Promise<boolean> {
    await yieldNow();
    const count = this.counters.get(key) ?? 0;
    if (count >= limit) {
      return false;
    }
    this.counters.set(key, count + 1);
    return true;
  }

  async scan(cursor?: string): Promise<ServerPage> {
    await yieldNow();
    // Two to a page, so that paging is exercised.
    const all = [...this.servers.values()].map((server) => ({ ...server }));
    const start = cursor === undefined ? 0 : Number(cursor);
    const end = start + 2;
    return {
      servers: all.slice(start, end),
      ...(end < all.length ? { cursor: String(end) } : {}),
    };
  }
}
