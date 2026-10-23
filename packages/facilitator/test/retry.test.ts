import { describe, expect, it } from "vitest";
import { isTransientError, withRetry } from "../src/retry.js";

const noSleep = async () => {};

describe("withRetry", () => {
  it("retries transient failures with backoff and returns the first success", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("Request failed with status code 520"), { response: { status: 520 } });
        return "ok";
      },
      { attempts: 4, baseMs: 100, sleep: async (ms) => void delays.push(ms) },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry a definitive error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error("bad request"), { response: { status: 400 } });
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  it("gives up after the configured attempts", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error("gateway"), { response: { status: 502 } });
        },
        { attempts: 3, sleep: noSleep },
      ),
    ).rejects.toThrow("gateway");
    expect(calls).toBe(3);
  });

  it("classifies transport errors and 5xx as transient, 4xx as not", () => {
    expect(isTransientError({ response: { status: 520 } })).toBe(true);
    expect(isTransientError({ response: { status: 429 } })).toBe(true);
    expect(isTransientError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientError(new TypeError("Cannot convert undefined or null to object"))).toBe(true);
    expect(isTransientError({ response: { status: 404 } })).toBe(false);
    expect(isTransientError(new Error("Bad union switch"))).toBe(false);
  });
});
