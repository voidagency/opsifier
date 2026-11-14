import { createHash } from "node:crypto";
import { tooManyRequests } from "../errors";

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface LimitedKey {
  key: string;
  rule: RateLimitRule;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** A consumed attempt. It stays counted unless the caller says it should not. */
export interface RateLimitReservation {
  /** Gives the attempt back, as if it had never been made. */
  refund(): void;
  /** Gives the attempt back and forgets earlier failures on the named keys. */
  forgive(...keys: string[]): void;
}

const SWEEP_INTERVAL_MS = 60_000;
const MAX_BUCKETS = 50_000;
/** How long an address an account signed in from stays known to it. */
const KNOWN_FOR_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_KNOWN = 50_000;

/** Keys are built from what clients send. A fixed-size digest keeps a bucket's memory fixed too. */
function bucketId(key: string): string {
  return createHash("sha256").update(key).digest("base64url");
}

/**
 * Fixed-window attempt counters, in memory: there is one panel process. Attempts are consumed
 * when they start rather than when they fail, because hashing is asynchronous and otherwise
 * any number of concurrent requests would pass the check before the first failure counted.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  /** Account and address pairs that signed in, with when they stop counting as known. */
  private readonly known = new Map<string, number>();
  private nextSweepAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one attempt against every key, or throws a 429 and counts nothing. */
  consume(keys: readonly LimitedKey[]): RateLimitReservation {
    const now = this.now();
    this.sweep(now);
    const limited = keys.map(({ key, rule }) => ({ id: bucketId(key), rule }));

    let retryAfterMs = 0;
    for (const { id, rule } of limited) {
      const bucket = this.liveBucket(id, now);
      if (bucket !== undefined && bucket.count >= rule.limit) {
        retryAfterMs = Math.max(retryAfterMs, bucket.resetAt - now);
      }
    }
    if (retryAfterMs > 0) {
      throw tooManyRequests(Math.ceil(retryAfterMs / 1000));
    }

    for (const { id, rule } of limited) {
      const bucket = this.liveBucket(id, now);
      if (bucket === undefined) {
        this.buckets.set(id, { count: 1, resetAt: now + rule.windowMs });
      } else {
        bucket.count += 1;
      }
    }

    let settled = false;
    const refund = () => {
      if (settled) {
        return;
      }
      settled = true;
      for (const { id } of limited) {
        const bucket = this.buckets.get(id);
        if (bucket !== undefined && bucket.count > 0) {
          bucket.count -= 1;
        }
      }
    };

    return {
      refund,
      forgive: (...forgiven) => {
        refund();
        for (const key of forgiven) {
          this.buckets.delete(bucketId(key));
        }
      },
    };
  }

  /** Remembers that this account signed in from this address. */
  rememberSignIn(account: string, address: string): void {
    const id = bucketId(`${account}\n${address}`);
    this.known.delete(id);
    this.known.set(id, this.now() + KNOWN_FOR_MS);
    for (const key of this.known.keys()) {
      if (this.known.size <= MAX_KNOWN) {
        break;
      }
      this.known.delete(key);
    }
  }

  /** Whether this account signed in from this address within the last 30 days. */
  hasSignedInFrom(account: string, address: string): boolean {
    const id = bucketId(`${account}\n${address}`);
    const until = this.known.get(id);
    if (until === undefined) {
      return false;
    }
    if (until <= this.now()) {
      this.known.delete(id);
      return false;
    }
    return true;
  }

  private liveBucket(key: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (bucket !== undefined && bucket.resetAt <= now) {
      this.buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  private sweep(now: number): void {
    if (now >= this.nextSweepAt) {
      this.nextSweepAt = now + SWEEP_INTERVAL_MS;
      for (const [key, bucket] of this.buckets) {
        if (bucket.resetAt <= now) {
          this.buckets.delete(key);
        }
      }
    }
    // Bounded memory under a flood of distinct keys: the oldest entries go first.
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= MAX_BUCKETS) {
        break;
      }
      this.buckets.delete(key);
    }
  }
}
