import type {
  Dns,
  DnsChange,
  FinalStatus,
  Lease,
  RecordSet,
  ServerRecord,
  ServerStatus,
  Store,
} from "./ports";
import {
  challengeFqdnOf,
  challengeNameOf,
  domainOf,
  hashSecret,
  isChallengeValue,
  isEmail,
  isIpv4,
  isPublicIpv4,
  isPurpose,
  isValidId,
  secretMatches,
  wildcardOf,
} from "./rules";

const ADDRESS_TTL_SECONDS = 300;
const CHALLENGE_TTL_SECONDS = 60;
/** Longer than any function runs, so a lease left by a crash ends and never overlaps a live one. */
const LEASE_MS = 30_000;
const LEASE_ATTEMPTS = 8;
const LEASE_RETRY_MS = 400;
const ID_ATTEMPTS = 8;
/** A request nobody answered goes, so a name isn't held for ever by someone who has moved on. */
const REQUEST_LIFETIME_DAYS = 30;
const COUNTER_LIFETIME_SECONDS = 2 * 86_400;
const DAY_MS = 86_400_000;
const MAX_CHALLENGE_BODY = 1024;
const MAX_REQUEST_BODY = 2048;

/** What whoever decides gets to see. */
export interface WaitingRequest {
  id: string;
  email: string;
  purpose: string;
  ip: string;
  requestedAt: string;
}

/** What is said to whoever decides, including the two commands that answer it. */
export const requestMessage = (request: WaitingRequest, zone: string): string =>
  [
    "A server is asking for an address.",
    "",
    `Address: ${domainOf(request.id, zone)}`,
    `Email: ${request.email}`,
    `Purpose: ${request.purpose}`,
    `Server IP: ${request.ip}`,
    `Requested: ${request.requestedAt}`,
    "",
    `Approve: infra/names/requests.sh <aws-profile> approve ${request.id}`,
    `Refuse: infra/names/requests.sh <aws-profile> refuse ${request.id}`,
  ].join("\n");

export interface Limits {
  registrationsPerIpPerDay: number;
  registrationsPerDay: number;
  /** Route 53 allows five requests a second per account, so one server can't be allowed to take them. */
  changesPerServerPerHour: number;
  inactiveAfterDays: number;
  /** Removed in one daily run. What's left waits for the next: a mistake can only do so much at once. */
  removalsPerRun: number;
  removalPauseMs: number;
  /** A TXT record that reaches this many values is replaced, so stale ones can't block a renewal. */
  maxChallengeValues: number;
}

export interface Deps {
  store: Store;
  dns: Dns;
  zone: string;
  limits: Limits;
  now(): number;
  newId(): string;
  newSecret(): string;
  newToken(): string;
  sleep(ms: number): Promise<void>;
  /** Named facts only. Nothing a request carries is ever passed here. */
  log(event: string, fields?: Record<string, string | number | boolean>): void;
  /** Says a request is waiting. If this fails the request still stands, and can be listed. */
  notify(request: WaitingRequest): Promise<void>;
}

/** A request the service refuses, and what the caller is told. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const unauthorized = () => new Refusal(401, "unauthorized", "These credentials are not valid.");
const unavailable = () => new Refusal(503, "unavailable", "The service could not complete this. Try again.");
const busy = () => new Refusal(503, "busy", "Another change to this server is in progress. Try again.");
const invalid = (message: string) => new Refusal(400, "invalid_request", message);

function assertPublicSource(sourceIp: string): void {
  if (!isIpv4(sourceIp)) {
    throw new Refusal(400, "ipv4_only", "Only IPv4 addresses are supported for now.");
  }
  if (!isPublicIpv4(sourceIp)) {
    throw new Refusal(400, "address_not_public", "This address is private or reserved.");
  }
}

const addressRecords = (id: string, zone: string, ip: string): RecordSet[] =>
  [domainOf(id, zone), wildcardOf(id, zone)].map((name) => ({
    name,
    type: "A",
    ttl: ADDRESS_TTL_SECONDS,
    values: [ip],
  }));

const upsert = (record: RecordSet): DnsChange => ({ action: "UPSERT", record });

/** Only these three names can ever belong to a server, whatever else the zone holds. */
async function ownedRecords(deps: Deps, id: string): Promise<RecordSet[]> {
  const domain = domainOf(id, deps.zone);
  const names = new Set([domain, wildcardOf(id, deps.zone), challengeNameOf(id, deps.zone)]);
  return (await deps.dns.list(domain)).filter((record) => names.has(record.name));
}

/**
 * Route 53 refuses a DELETE that doesn't match exactly, so what is really there is read first: after a
 * lost write the row and the zone can disagree, and that must not leave a record behind for ever.
 */
async function removeRecords(deps: Deps, id: string): Promise<void> {
  const records = await ownedRecords(deps, id);
  if (records.length > 0) {
    await deps.dns.change(records.map((record) => ({ action: "DELETE", record })));
  }
}

/** One change per server at a time, so that a late DNS write can never bring back what was removed. */
async function withLease<T>(
  deps: Deps,
  id: string,
  statuses: readonly ServerStatus[],
  work: (lease: Lease) => Promise<T>,
): Promise<T> {
  const lease: Lease = { id, token: deps.newToken() };
  for (let attempt = 1; ; attempt += 1) {
    const now = deps.now();
    const outcome = await deps.store.lease(lease, statuses, now, now + LEASE_MS);
    if (outcome === "leased") {
      break;
    }
    if (outcome === "refused") {
      throw unauthorized();
    }
    if (attempt >= LEASE_ATTEMPTS) {
      throw busy();
    }
    await deps.sleep(LEASE_RETRY_MS);
  }
  try {
    return await work(lease);
  } finally {
    await deps.store.unlease(lease).catch((error: unknown) => {
      deps.log("unlease_failed", { id, error: errorName(error) });
    });
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

async function spendChange(deps: Deps, id: string): Promise<void> {
  const now = deps.now();
  const hour = Math.floor(now / 3_600_000);
  const within = await deps.store.hit(
    `server#${id}#${hour}`,
    deps.limits.changesPerServerPerHour,
    Math.ceil(now / 1000) + COUNTER_LIFETIME_SECONDS,
  );
  if (!within) {
    throw new Refusal(429, "rate_limited", "Too many changes to this server. Try again later.");
  }
}

interface Credentials {
  id: string;
  secret: string;
}

interface Authentication {
  credentials: Credentials | null;
  /** The ID named in the URL, which has to be the one the credentials are for. */
  pathId?: string;
  allow?: readonly ServerStatus[];
}

async function authenticate(
  deps: Deps,
  { credentials, pathId, allow = ["active"] }: Authentication,
): Promise<ServerRecord> {
  const named =
    credentials !== null && isValidId(credentials.id) && (pathId === undefined || pathId === credentials.id);
  const server = named && credentials !== null ? await deps.store.get(credentials.id) : null;
  if (!secretMatches(credentials?.secret ?? "", server?.secretHash) || server === null) {
    throw unauthorized();
  }
  if (server.status === "disabled") {
    throw new Refusal(410, "disabled", "This address has been disabled.");
  }
  if (server.status === "refused") {
    throw new Refusal(410, "refused", "This request was refused.");
  }
  if (!allow.includes(server.status)) {
    throw unauthorized();
  }
  return server;
}

export interface Requested {
  id: string;
  secret: string;
  domain: string;
  ip: string;
  status: "requested";
}

async function withinRegistrationLimits(deps: Deps, sourceIp: string, now: number): Promise<void> {
  const day = new Date(now).toISOString().slice(0, 10);
  const expires = Math.ceil(now / 1000) + COUNTER_LIFETIME_SECONDS;
  const { registrationsPerIpPerDay, registrationsPerDay } = deps.limits;
  // The address first: someone who is over their own limit must not use up everyone else's.
  if (!(await deps.store.hit(`ip#${sourceIp}#${day}`, registrationsPerIpPerDay, expires))) {
    throw new Refusal(429, "rate_limited", "Too many registrations from this address today.");
  }
  if (!(await deps.store.hit(`global#${day}`, registrationsPerDay, expires))) {
    deps.log("daily_cap_reached", { limit: registrationsPerDay });
    throw new Refusal(503, "capacity", "The service is not taking new registrations today.");
  }
}

async function claimId(deps: Deps, draft: Omit<ServerRecord, "id">): Promise<string> {
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
    const id = deps.newId();
    if (isValidId(id) && (await deps.store.create({ ...draft, id }))) {
      return id;
    }
  }
  throw unavailable();
}

function parseRequest(body: string | undefined): { email: string; purpose: string } {
  if (body === undefined || body.length > MAX_REQUEST_BODY) {
    throw invalid("Send { email, purpose }.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid("The body is not JSON.");
  }
  const { email, purpose } = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  if (typeof email !== "string" || !isEmail(email)) {
    throw invalid("This is not an email address.");
  }
  if (typeof purpose !== "string" || !isPurpose(purpose)) {
    throw invalid("Say in a few words what this server is for.");
  }
  // On one line: it ends up in a message whose other lines are the commands that answer it.
  return { email, purpose: purpose.trim().replace(/\s+/g, " ") };
}

/**
 * Asks for an address. Nothing reaches the zone here: the row holds a name and says who asked, and the
 * records only exist once someone has approved it, so an open form can't put anything on the domain.
 */
export async function requestAddress(
  deps: Deps,
  sourceIp: string,
  body: string | undefined,
): Promise<Requested> {
  assertPublicSource(sourceIp);
  const request = parseRequest(body);
  const now = deps.now();
  await withinRegistrationLimits(deps, sourceIp, now);

  const secret = deps.newSecret();
  const id = await claimId(deps, {
    status: "requested",
    secretHash: hashSecret(secret),
    ip: sourceIp,
    createdAt: now,
    lastSeen: now,
    ...request,
  });
  const waiting = { id, ...request, ip: sourceIp, requestedAt: new Date(now).toISOString() };
  await deps.notify(waiting).catch((error: unknown) => {
    deps.log("notify_failed", { id, error: errorName(error) });
  });
  return { id, secret, domain: domainOf(id, deps.zone), ip: sourceIp, status: "requested" };
}

export interface Heartbeat {
  id: string;
  domain: string;
  ip: string;
  lastSeen: string;
  /** While `requested` the server is only asking whether it has been answered. */
  status: "active" | "requested";
}

/** Most heartbeats change nothing but a timestamp. Only an address that moved goes near Route 53. */
export async function heartbeat(
  deps: Deps,
  credentials: Credentials | null,
  pathId: string | undefined,
  sourceIp: string,
): Promise<Heartbeat> {
  const server = await authenticate(deps, { credentials, pathId, allow: ["active", "requested"] });
  assertPublicSource(sourceIp);
  const now = deps.now();
  const answer = {
    id: server.id,
    domain: domainOf(server.id, deps.zone),
    ip: sourceIp,
    lastSeen: new Date(now).toISOString(),
    status: "active" as const,
  };
  if (server.status === "requested") {
    // Kept current so that an approval points at where the server is by then. Still nothing in the zone.
    if (server.ip !== sourceIp) {
      await spendChange(deps, server.id);
      await withLease(deps, server.id, ["requested"], async (lease) => {
        await deps.store.update(lease, { ip: sourceIp, lastSeen: now });
      });
    }
    return { ...answer, status: "requested" };
  }
  if (server.ip === sourceIp && (await deps.store.touch(server.id, sourceIp, now))) {
    return answer;
  }

  await spendChange(deps, server.id);
  await withLease(deps, server.id, ["active"], async (lease) => {
    try {
      await deps.dns.change(addressRecords(server.id, deps.zone, sourceIp).map(upsert));
    } catch (error) {
      deps.log("move_failed", { id: server.id, error: errorName(error) });
      throw unavailable();
    }
    // If this write is lost the row is simply behind, and the next heartbeat brings it level.
    if (!(await deps.store.update(lease, { ip: sourceIp, lastSeen: now }))) {
      throw unavailable();
    }
  });
  return answer;
}

/** Marks the intent first, so that a crash after this point is finished by the daily job. */
async function removeUnderLease(deps: Deps, lease: Lease, target: FinalStatus): Promise<void> {
  await deps.store.update(lease, { status: "removing", removeTo: target });
  await removeRecords(deps, lease.id);
  await deps.store.update(lease, {
    status: target,
    removeTo: null,
    ip: null,
    email: null,
    purpose: null,
    // A disabled or refused server keeps its hash, to be told so rather than treated as a stranger.
    ...(target === "disabled" || target === "refused" ? {} : { secretHash: null }),
  });
}

/** The row stays as a tombstone: conditional writes then keep the ID from ever being issued again. */
export async function release(
  deps: Deps,
  credentials: Credentials | null,
  pathId: string | undefined,
): Promise<{ id: string; released: true }> {
  // Also how a server withdraws a request nobody has answered yet.
  const allow: ServerStatus[] = ["active", "requested", "removing"];
  const server = await authenticate(deps, { credentials, pathId, allow });
  await withLease(deps, server.id, allow, async (lease) => {
    try {
      await removeUnderLease(deps, lease, "released");
    } catch (error) {
      deps.log("release_failed", { id: server.id, error: errorName(error) });
      throw unavailable();
    }
  });
  return { id: server.id, released: true };
}

function parseChallenge(deps: Deps, id: string, body: string | undefined): { value: string } {
  if (body === undefined || body.length > MAX_CHALLENGE_BODY) {
    throw invalid("Send { fqdn, value }.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid("The body is not JSON.");
  }
  const { fqdn, value } = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  if (fqdn !== challengeFqdnOf(id, deps.zone)) {
    throw new Refusal(403, "forbidden", "A server can only answer for its own challenge name.");
  }
  if (typeof value !== "string" || !isChallengeValue(value)) {
    throw invalid("This is not a challenge value.");
  }
  return { value };
}

const currentChallenge = async (deps: Deps, id: string): Promise<RecordSet | undefined> =>
  (await ownedRecords(deps, id)).find(
    (record) => record.type === "TXT" && record.name === challengeNameOf(id, deps.zone),
  );

/**
 * A wildcard and its base name share one TXT name, and a change replaces the whole set, so the set is
 * read and written under the lease. A lost update would drop a challenge that is still being checked.
 */
export async function presentChallenge(
  deps: Deps,
  credentials: Credentials | null,
  body: string | undefined,
): Promise<void> {
  const server = await authenticate(deps, { credentials });
  const { value } = parseChallenge(deps, server.id, body);
  await spendChange(deps, server.id);
  await withLease(deps, server.id, ["active"], async () => {
    const current = await currentChallenge(deps, server.id);
    const values = current?.values ?? [];
    if (values.includes(value)) {
      return;
    }
    await deps.dns.change([
      upsert({
        name: challengeNameOf(server.id, deps.zone),
        type: "TXT",
        ttl: CHALLENGE_TTL_SECONDS,
        values: values.length >= deps.limits.maxChallengeValues ? [value] : [...values, value],
      }),
    ]);
  });
}

export async function cleanupChallenge(
  deps: Deps,
  credentials: Credentials | null,
  body: string | undefined,
): Promise<void> {
  const server = await authenticate(deps, { credentials });
  const { value } = parseChallenge(deps, server.id, body);
  await spendChange(deps, server.id);
  await withLease(deps, server.id, ["active"], async () => {
    const current = await currentChallenge(deps, server.id);
    if (current === undefined || !current.values.includes(value)) {
      return;
    }
    const values = current.values.filter((candidate) => candidate !== value);
    await deps.dns.change([
      values.length === 0 ? { action: "DELETE", record: current } : upsert({ ...current, values }),
    ]);
  });
}

async function operatorTarget(deps: Deps, id: string): Promise<ServerRecord> {
  if (!isValidId(id)) {
    throw invalid("This is not an ID.");
  }
  const server = await deps.store.get(id);
  if (server === null) {
    throw new Refusal(404, "not_found", "No server has this ID.");
  }
  return server;
}

const notWaiting = () => new Refusal(409, "not_waiting", "This server is not waiting for an answer.");

/** An operator's decision, reached only by invoking the function directly: no route leads here. */
export async function disableServer(deps: Deps, id: string): Promise<{ id: string; status: "disabled" }> {
  const server = await operatorTarget(deps, id);
  if (server.status !== "disabled") {
    await withLease(
      deps,
      id,
      ["requested", "active", "removing", "released", "expired", "refused"],
      (lease) => removeUnderLease(deps, lease, "disabled"),
    );
  }
  return { id, status: "disabled" };
}

/**
 * Also an operator's decision. UPSERT and the lease make it safe to repeat, so if a step fails, or the
 * answer is lost, approving again finishes it. The records use the IP from the row as it is now.
 */
export async function approveServer(
  deps: Deps,
  id: string,
): Promise<{ id: string; status: "active"; domain: string }> {
  const server = await operatorTarget(deps, id);
  if (server.status !== "active") {
    if (server.status !== "requested") {
      throw notWaiting();
    }
    await withLease(deps, id, ["requested"], async (lease) => {
      const ip = (await deps.store.get(id))?.ip;
      if (ip === undefined) {
        throw unavailable();
      }
      await deps.dns.change(addressRecords(id, deps.zone, ip).map(upsert));
      if (!(await deps.store.update(lease, { status: "active", lastSeen: deps.now() }))) {
        throw unavailable();
      }
    });
  }
  return { id, status: "active", domain: domainOf(id, deps.zone) };
}

export async function refuseServer(deps: Deps, id: string): Promise<{ id: string; status: "refused" }> {
  const server = await operatorTarget(deps, id);
  if (server.status !== "refused") {
    if (server.status !== "requested") {
      throw notWaiting();
    }
    await withLease(deps, id, ["requested"], (lease) => removeUnderLease(deps, lease, "refused"));
  }
  return { id, status: "refused" };
}

/** Oldest first: whoever has been waiting longest is answered first. */
export async function listRequests(deps: Deps): Promise<WaitingRequest[]> {
  const waiting: WaitingRequest[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.store.scan(cursor);
    for (const server of page.servers) {
      if (server.status === "requested") {
        waiting.push({
          id: server.id,
          email: server.email ?? "",
          purpose: server.purpose ?? "",
          ip: server.ip ?? "",
          requestedAt: new Date(server.createdAt).toISOString(),
        });
      }
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return waiting.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export interface SweepReport {
  scanned: number;
  /** Removals that had been interrupted, now finished. */
  finished: number;
  /** Addresses with no heartbeat for too long, and requests nobody answered. */
  expired: number;
  failed: number;
  /** Set when the run stopped at its limit, leaving the rest for the next one. */
  stoppedEarly: boolean;
}

/** A heartbeat may have arrived since the scan, so the row is read again under the lease. */
async function expireIfStillSilent(deps: Deps, id: string, cutoff: number): Promise<boolean> {
  return withLease(deps, id, ["active"], async (lease) => {
    const current = await deps.store.get(id);
    if (current === null || current.status !== "active" || current.lastSeen >= cutoff) {
      return false;
    }
    await removeUnderLease(deps, lease, "expired");
    return true;
  });
}

type RepairOutcome = "finished" | "expired" | null;

async function repair(deps: Deps, server: ServerRecord, cutoff: number): Promise<RepairOutcome> {
  const { id, status } = server;
  if (status === "requested") {
    // Through the same removal as anything else: an approval that crashed halfway can have left records.
    await withLease(deps, id, ["requested"], (lease) => removeUnderLease(deps, lease, "expired"));
    return "expired";
  }
  if (status === "removing") {
    await withLease(deps, id, ["removing"], (lease) =>
      removeUnderLease(deps, lease, server.removeTo ?? "expired"),
    );
    return "finished";
  }
  if (status === "active" && server.lastSeen < cutoff) {
    return (await expireIfStillSilent(deps, id, cutoff)) ? "expired" : null;
  }
  return null;
}

const needsAttention = (server: ServerRecord, cutoff: number, requestsBefore: number): boolean =>
  server.status === "removing" ||
  (server.status === "requested" && server.createdAt < requestsBefore) ||
  (server.status === "active" && server.lastSeen < cutoff);

/**
 * The daily job. Dangling records are a takeover risk, because cloud IPs get reused, so an address with
 * no heartbeat for too long goes, so does a request nobody answered, and whatever a crash left half done
 * is finished. One failure never
 * stops the run, and the work is paced to stay inside Route 53's rate limit.
 */
export async function sweep(deps: Deps): Promise<SweepReport> {
  const report: SweepReport = {
    scanned: 0,
    finished: 0,
    expired: 0,
    failed: 0,
    stoppedEarly: false,
  };
  const now = deps.now();
  const cutoff = now - deps.limits.inactiveAfterDays * DAY_MS;
  const requestsBefore = now - REQUEST_LIFETIME_DAYS * DAY_MS;
  let removals = 0;
  let cursor: string | undefined;
  do {
    const page = await deps.store.scan(cursor);
    for (const server of page.servers) {
      report.scanned += 1;
      if (!needsAttention(server, cutoff, requestsBefore)) {
        continue;
      }
      if (removals >= deps.limits.removalsPerRun) {
        report.stoppedEarly = true;
        return report;
      }
      removals += 1;
      try {
        const outcome = await repair(deps, server, cutoff);
        if (outcome !== null) {
          report[outcome] += 1;
        }
      } catch (error) {
        report.failed += 1;
        deps.log("sweep_item_failed", { id: server.id, error: errorName(error) });
      }
      await deps.sleep(deps.limits.removalPauseMs);
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return report;
}
