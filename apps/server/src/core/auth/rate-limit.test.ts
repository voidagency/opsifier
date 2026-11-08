import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { RateLimiter } from "./rate-limit";

const rule = { limit: 2, windowMs: 60_000 };

function storedKeys(limiter: RateLimiter): string[] {
  return [...(limiter as unknown as { buckets: Map<string, unknown> }).buckets.keys()];
}

describe("RateLimiter", () => {
  it("keeps a fixed-size key in memory, however long the one it was given", () => {
    const limiter = new RateLimiter();
    limiter.consume([{ key: `login:email:${"a".repeat(1024 * 1024)}@example.com`, rule }]);
    limiter.consume([{ key: "login:address:203.0.113.5", rule }]);

    const keys = storedKeys(limiter);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toHaveLength(keys[1]?.length as number);
    expect(keys[0]?.length).toBeLessThanOrEqual(64);
    expect(keys.join("")).not.toContain("example.com");
  });

  it("still counts each distinct key on its own", () => {
    const limiter = new RateLimiter();
    const pair = [{ key: "a", rule }];
    limiter.consume(pair);
    limiter.consume(pair);

    expect(() => limiter.consume(pair)).toThrow(AppError);
    expect(() => limiter.consume([{ key: "b", rule }])).not.toThrow();
  });

  it("can still forgive a key by the name it was given", () => {
    const limiter = new RateLimiter();
    const keys = [{ key: "pair", rule }];
    limiter.consume(keys);
    const second = limiter.consume(keys);

    second.forgive("pair");

    expect(storedKeys(limiter)).toHaveLength(0);
    expect(() => limiter.consume(keys)).not.toThrow();
  });

  it("can still refund an attempt", () => {
    const limiter = new RateLimiter();
    const keys = [{ key: "pair", rule }];
    limiter.consume(keys);
    limiter.consume(keys).refund();

    expect(() => limiter.consume(keys)).not.toThrow();
    expect(() => limiter.consume(keys)).toThrow(AppError);
  });
});
