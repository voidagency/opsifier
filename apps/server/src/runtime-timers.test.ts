import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestContext } from "./testing/harness";

describe("the timers a panel starts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stop with the panel that started them, even with a second panel in the same process", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const context = await createTestContext();
    // A second panel boots in the same process, as a restart in a test does.
    await context.restart();
    await context.close();

    // Nothing is left to run on a database that is closed now.
    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.advanceTimersByTime(10 * 60_000)).not.toThrow();
  });
});
